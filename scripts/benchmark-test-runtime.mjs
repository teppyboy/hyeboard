import { spawnSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  installSignalAbortHandlers,
  runTrackedCommands,
  TrackedProcessRunner,
} from "./benchmark-process-runner.mjs";
import { parsePlaywrightRuntimeConfig } from "../apps/web/src/lib/testing/playwright-runtime-config.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(scriptPath), "..");
const pnpmExecutable = "pnpm";
const capturedOnlyOutput = { write() {} };

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function parseArguments(argumentsList, environment) {
  const options = {
    runs: 3,
    workers: undefined,
    label: "acceptance",
    deadlineMs:
      environment.HYEB_BENCHMARK_RUN_DEADLINE_MS === undefined
        ? 90_000
        : Number(environment.HYEB_BENCHMARK_RUN_DEADLINE_MS),
  };
  for (const argument of argumentsList) {
    const [name, rawValue] = argument.split("=", 2);
    if (name === "--runs") options.runs = Number(rawValue);
    else if (name === "--workers") options.workers = rawValue;
    else if (name === "--label") options.label = rawValue;
    else if (name === "--deadline-ms") options.deadlineMs = Number(rawValue);
    else throw new Error(`Unknown benchmark argument: ${argument}`);
  }
  if (!Number.isInteger(options.runs) || options.runs < 1)
    throw new Error("--runs must be a positive integer");
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(options.label))
    throw new Error("--label must contain only letters, numbers, and hyphens");
  if (!Number.isInteger(options.deadlineMs) || options.deadlineMs < 75_000)
    throw new Error(
      "Benchmark deadline must be an integer of at least 75000ms",
    );
  return options;
}

function pnpmInvocation(args, environment) {
  if (process.platform !== "win32") return { command: pnpmExecutable, args };
  if (args.some((argument) => !/^[A-Za-z0-9@/_.:=-]+$/.test(argument)))
    throw new Error("Unsafe pnpm command argument");
  return {
    command: environment.ComSpec ?? "cmd.exe",
    args: ["/d", "/s", "/c", `pnpm ${args.join(" ")}`],
  };
}

function commandVersion(command, args, environment) {
  const invocation =
    command === pnpmExecutable
      ? pnpmInvocation(args, environment)
      : { command, args };
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: environment,
    shell: false,
  });
  if (result.status !== 0)
    throw new Error(`Version command failed: ${command} ${args.join(" ")}`);
  return result.stdout.trim();
}

function readWindowsTopology() {
  if (process.platform !== "win32") {
    return {
      processorModel: os.cpus()[0]?.model ?? "unknown",
      packages: 1,
      cores: os.cpus().length,
      logicalProcessors: os.cpus().length,
      memoryBytes: os.totalmem(),
      operatingSystem: `${os.type()} ${os.release()}`,
    };
  }
  const script = [
    "$p=@(Get-CimInstance Win32_Processor)",
    "$c=Get-CimInstance Win32_ComputerSystem",
    "$o=Get-CimInstance Win32_OperatingSystem",
    "[ordered]@{processorModel=(($p|ForEach-Object {$_.Name.Trim()}) -join ' | ');packages=$p.Count;cores=($p|Measure-Object NumberOfCores -Sum).Sum;logicalProcessors=($p|Measure-Object NumberOfLogicalProcessors -Sum).Sum;memoryBytes=[int64]$c.TotalPhysicalMemory;operatingSystem=($o.Caption+' '+$o.Version)}|ConvertTo-Json -Compress",
  ].join(";");
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-Command", script],
    { encoding: "utf8", shell: false },
  );
  if (result.status !== 0)
    throw new Error(`Topology query failed: ${result.stderr.trim()}`);
  return JSON.parse(result.stdout.trim());
}

function getTopology(environment) {
  return {
    ...readWindowsTopology(),
    node: process.version,
    pnpm: commandVersion(pnpmExecutable, ["--version"], environment),
    playwright: commandVersion(
      pnpmExecutable,
      ["--filter", "@hyeboard/web", "exec", "playwright", "--version"],
      environment,
    ),
  };
}

function probePort(host, port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", (error) => {
      if (error.code === "EADDRINUSE" || error.code === "EACCES")
        resolve(false);
      else reject(error);
    });
    server.listen({ host, port, exclusive: true }, () =>
      server.close((error) => (error ? reject(error) : resolve(true))),
    );
  });
}

async function assertPortsFree(runtime, phase) {
  const checks = await Promise.all([
    probePort(runtime.host, runtime.vitePort),
    probePort("127.0.0.1", runtime.workerPort),
  ]);
  if (checks.every(Boolean)) return;
  throw new Error(
    `${phase} port check failed: Vite ${runtime.host}:${runtime.vitePort} free=${checks[0]}, Worker 127.0.0.1:${runtime.workerPort} free=${checks[1]}`,
  );
}

async function waitForPortsReleased(runtime) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      await assertPortsFree(runtime, "Post-run");
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  await assertPortsFree(runtime, "Post-run server leak");
}

function collectSpecs(suite) {
  return [
    ...(suite.specs ?? []),
    ...(suite.suites ?? []).flatMap(collectSpecs),
  ];
}

async function parsePlaywrightReport(reportPath) {
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  if ((report.errors ?? []).length)
    throw new Error(
      `Playwright report contains ${report.errors.length} top-level errors`,
    );
  const tests = (report.suites ?? [])
    .flatMap(collectSpecs)
    .flatMap((spec) =>
      (spec.tests ?? []).map((test) => ({
        title: spec.title,
        project: test.projectName,
        outcome: test.status,
        results: test.results ?? [],
      })),
    );
  const identities = new Set();
  for (const test of tests) {
    const identity = `${test.project}\0${test.title}`;
    if (identities.has(identity))
      throw new Error(
        `Duplicate Playwright identity: ${test.project} / ${test.title}`,
      );
    identities.add(identity);
  }
  const unknownProjects = [
    ...new Set(
      tests
        .map((test) => test.project)
        .filter((project) => !["chromium", "webkit"].includes(project)),
    ),
  ];
  if (unknownProjects.length)
    throw new Error(
      `Unknown Playwright projects: ${unknownProjects.join(", ")}`,
    );

  const projects = {};
  for (const [project, expected] of [
    ["chromium", 68],
    ["webkit", 14],
  ]) {
    const selected = tests.filter((test) => test.project === project);
    const retries = selected
      .flatMap((test) => test.results)
      .filter((result) => result.retry !== 0).length;
    const skipped = selected.filter(
      (test) =>
        test.outcome === "skipped" ||
        test.results.some((result) => result.status === "skipped"),
    ).length;
    const flaky = selected.filter(
      (test) => test.outcome === "flaky" || test.results.length !== 1,
    ).length;
    const failures = selected.filter(
      (test) =>
        test.outcome !== "expected" ||
        test.results.length !== 1 ||
        test.results[0]?.status !== "passed",
    ).length;
    const passed = selected.filter(
      (test) =>
        test.outcome === "expected" &&
        test.results.length === 1 &&
        test.results[0]?.status === "passed",
    ).length;
    if (
      selected.length !== expected ||
      passed !== expected ||
      skipped ||
      retries ||
      flaky ||
      failures
    ) {
      throw new Error(
        `${project} report mismatch: selected=${selected.length}, passed=${passed}, skipped=${skipped}, retries=${retries}, flaky=${flaky}, failures=${failures}`,
      );
    }
    projects[project] = {
      selected: selected.length,
      passed,
      skipped,
      retries,
      flaky,
      failures,
    };
  }
  return projects;
}

function assertSameTopology(baseline, candidate, run) {
  for (const field of [
    "processorModel",
    "packages",
    "cores",
    "logicalProcessors",
    "memoryBytes",
  ]) {
    if (baseline[field] !== candidate[field])
      throw new Error(`Topology changed before run ${run}: ${field}`);
  }
}

function commandDefinition(name, args, environment, outputPath) {
  const invocation = pnpmInvocation(args, environment);
  return { name, ...invocation, outputPath };
}

function commandResult(results, name) {
  return results?.[name] ?? { exitCode: null, signal: null };
}

async function persistJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function executeRun({
  run,
  options,
  runtime,
  effectiveEnvironment,
  baselineTopology,
  artifactRoot,
  runner,
  signal,
}) {
  const runDirectory = path.join(artifactRoot, `run-${run}`);
  await rm(runDirectory, { recursive: true, force: true });
  await mkdir(runDirectory, { recursive: true });
  const reportPath = path.join(runDirectory, "playwright.json");
  const startedAt = process.hrtime.bigint();
  let topology;
  let results = {};
  let failure;
  let portsReleased = false;

  try {
    if (signal.aborted) throw signal.reason;
    await assertPortsFree(runtime, `Pre-run ${run}`);
    topology = getTopology(effectiveEnvironment);
    assertSameTopology(baselineTopology, topology, run);
    const commonEnvironment = {
      ...effectiveEnvironment,
      HYEB_COMBINED_GATE: "1",
      PLAYWRIGHT_JSON_OUTPUT_FILE: reportPath,
    };
    results = await runTrackedCommands({
      commands: [
        commandDefinition(
          "unit",
          ["test"],
          commonEnvironment,
          path.join(runDirectory, "unit.log"),
        ),
        commandDefinition(
          "browser",
          [
            "--filter",
            "@hyeboard/web",
            "exec",
            "playwright",
            "test",
            "--retries=0",
            "--reporter=json",
          ],
          commonEnvironment,
          path.join(runDirectory, "browser.log"),
        ),
      ],
      cwd: repositoryRoot,
      environment: commonEnvironment,
      deadlineMs: options.deadlineMs,
      signal,
      output: capturedOnlyOutput,
      runner,
    });
    if (signal.aborted) throw signal.reason;
  } catch (error) {
    results = error?.results ?? results;
    failure = error;
  } finally {
    try {
      await runner.terminateAll();
    } catch (error) {
      failure = failure
        ? new AggregateError(
            [failure, error],
            `${errorMessage(failure)}; tracked cleanup failed: ${errorMessage(error)}`,
          )
        : error;
    }
    try {
      await waitForPortsReleased(runtime);
      portsReleased = true;
    } catch (error) {
      failure = failure
        ? new AggregateError(
            [failure, error],
            `${errorMessage(failure)}; port cleanup failed: ${errorMessage(error)}`,
          )
        : error;
    }
  }

  const elapsedSeconds = Number(process.hrtime.bigint() - startedAt) / 1e9;
  const unit = commandResult(results, "unit");
  const browser = commandResult(results, "browser");
  const evidence = {
    run,
    elapsedSeconds: Number(elapsedSeconds.toFixed(3)),
    deadlineMs: options.deadlineMs,
    exits: { unit: unit.exitCode, browser: browser.exitCode },
    signals: { unit: unit.signal, browser: browser.signal },
    runtime,
    topology: topology ?? baselineTopology,
    portsReleased,
  };

  try {
    evidence.projects = await parsePlaywrightReport(reportPath);
  } catch (error) {
    evidence.reportError = errorMessage(error);
  }
  if (!failure && evidence.reportError)
    failure = new Error(
      `Run ${run} JSON validation failed: ${evidence.reportError}`,
    );
  if (!failure && (unit.exitCode !== 0 || browser.exitCode !== 0))
    failure = new Error(
      `Run ${run} command failure: unit=${unit.exitCode}, browser=${browser.exitCode}`,
    );
  if (!failure && elapsedSeconds >= 60)
    failure = new Error(
      `Run ${run} missed 60.0 second gate: ${elapsedSeconds.toFixed(3)}s`,
    );
  if (failure) evidence.failure = errorMessage(failure);
  await persistJson(path.join(runDirectory, "evidence.json"), evidence);
  if (failure) throw failure;
  return evidence;
}

export async function main(
  argumentsList = process.argv.slice(2),
  environment = process.env,
) {
  if (path.resolve(process.cwd()) !== repositoryRoot)
    throw new Error(`Run benchmark from repository root: ${repositoryRoot}`);
  const options = parseArguments(argumentsList, environment);
  const effectiveEnvironment = {
    ...environment,
    ...(options.workers === undefined ? {} : { PW_WORKERS: options.workers }),
  };
  const runtime = parsePlaywrightRuntimeConfig(effectiveEnvironment);
  const artifactRoot = path.join(
    repositoryRoot,
    "apps/web/test-results/runtime-benchmark",
    options.label,
  );
  const runner = new TrackedProcessRunner();
  const abortController = new AbortController();
  const removeSignalHandlers = installSignalAbortHandlers(
    process,
    abortController,
  );
  let terminalFailure;

  try {
    await mkdir(artifactRoot, { recursive: true });
    await Promise.all([
      rm(path.join(artifactRoot, "failure.json"), { force: true }),
      rm(path.join(artifactRoot, "summary.json"), { force: true }),
    ]);
    const baselineTopology = getTopology(effectiveEnvironment);
    const acceptedRuns = [];
    for (let run = 1; run <= options.runs; run += 1) {
      const evidence = await executeRun({
        run,
        options,
        runtime,
        effectiveEnvironment,
        baselineTopology,
        artifactRoot,
        runner,
        signal: abortController.signal,
      });
      acceptedRuns.push(evidence);
      console.log(
        `Accepted ${options.label} run ${run}/${options.runs}: ${evidence.elapsedSeconds.toFixed(3)}s`,
      );
    }
    await persistJson(path.join(artifactRoot, "summary.json"), acceptedRuns);
  } catch (error) {
    terminalFailure = error;
    try {
      await persistJson(path.join(artifactRoot, "failure.json"), {
        failedAt: new Date().toISOString(),
        failure: errorMessage(error),
        signal: abortController.signal.aborted
          ? errorMessage(abortController.signal.reason)
          : null,
        trackedProcessIds: runner.activeProcessIds,
      });
    } catch (writeError) {
      terminalFailure = new AggregateError(
        [error, writeError],
        `${errorMessage(error)}; failure evidence write failed: ${errorMessage(writeError)}`,
      );
    }
  } finally {
    removeSignalHandlers();
    try {
      await runner.terminateAll();
      await waitForPortsReleased(runtime);
    } catch (cleanupError) {
      terminalFailure = terminalFailure
        ? new AggregateError(
            [terminalFailure, cleanupError],
            `${errorMessage(terminalFailure)}; final cleanup failed: ${errorMessage(cleanupError)}`,
          )
        : cleanupError;
    }
  }
  if (terminalFailure) throw terminalFailure;
}

const isMainModule =
  process.argv[1] && path.resolve(process.argv[1]) === scriptPath;
if (isMainModule) {
  try {
    await main();
  } catch (error) {
    console.error(errorMessage(error));
    process.exitCode = 1;
  }
}
