import { useNavigate } from "@tanstack/react-router";
import { LogOut, Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { FeatureHeader } from "@/components/shared";
import { LOCALES, type Locale, useLocale } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { useHyeboard } from "@/state";

declare const __HYEB_GIT_COMMIT__: string;

const THEME_HUE_PRESETS = [
  { hue: 209, key: "blue" },
  { hue: 152, key: "green" },
  { hue: 0, key: "red" },
  { hue: 271, key: "purple" },
  { hue: 25, key: "orange" },
  { hue: 199, key: "teal" },
] as const;

export function SettingsPage() {
  const state = useHyeboard();
  const { t, locale, setLocale } = useLocale();
  const navigate = useNavigate();
  const data = state.dashboard.data;
  const signOut = () => { state.logout(); void navigate({ to: "/login" }); };
  return (
    <div className="space-y-6">
      <FeatureHeader title={t.settings.title} description={t.settings.description} />
      <div className="grid max-w-lg gap-4">
        <Card>
          <CardHeader>
            <CardTitle>{t.settings.display}</CardTitle>
            <CardDescription>{t.settings.displayDesc}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-sm">{t.settings.colorMode}</span>
              <Button variant="outline" size="sm" className="max-lg:min-h-11" onClick={() => state.setMode(state.mode === "dark" ? "light" : "dark")} aria-label={t.common.toggleLightDark}>
                {state.mode === "dark" ? <><Sun size={14} className="mr-1" />{t.common.light}</> : <><Moon size={14} className="mr-1" />{t.common.dark}</>}
              </Button>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm">{t.settings.themeStyle}</span>
              <div className="flex rounded-lg border border-border p-1" role="group" aria-label={t.settings.themeStyle}>
                <Button type="button" variant={state.palette === "geist" ? "default" : "ghost"} size="sm" onClick={() => state.setPalette("geist")}>{t.settings.neutral}</Button>
                <Button type="button" variant={state.palette !== "geist" ? "default" : "ghost"} size="sm" onClick={() => state.setPalette(state.universityId === "uet" || state.universityId === "vnu" ? state.universityId : "uet")}>{t.settings.colored}</Button>
              </div>
            </div>
            {state.palette === "uet" || state.palette === "vnu" ? (
              <div className="flex items-center justify-between">
                <span className="text-sm">{t.settings.themeColor}</span>
                <div className="flex items-center gap-1.5" role="group" aria-label={t.settings.themeColor}>
                  {THEME_HUE_PRESETS.map((preset) => (
                    <button
                      key={preset.hue}
                      type="button"
                      title={t.colors[preset.key]}
                      aria-label={t.colors[preset.key]}
                      aria-pressed={state.themeHue === preset.hue}
                      onClick={() => state.setThemeHue(preset.hue)}
                      className={cn(
                        "h-6 w-6 shrink-0 rounded-full border transition-transform",
                        state.themeHue === preset.hue ? "border-foreground scale-110" : "border-border hover:scale-105",
                      )}
                      style={{ background: `hsl(${preset.hue} 80% 45%)` }}
                    />
                  ))}
                </div>
              </div>
            ) : null}
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm">{t.settings.language}</span>
              <Select value={locale} onValueChange={(value) => setLocale(value as Locale)}>
                <SelectTrigger className="h-9 w-[160px]" aria-label={t.settings.language}><SelectValue /></SelectTrigger>
                <SelectContent>
                  {LOCALES.map((option) => <SelectItem key={option.id} value={option.id}>{option.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>{t.settings.account}</CardTitle>
            <CardDescription>{data?.student?.fullName ? t.settings.signedInAs(data.student.fullName, data.student.studentCode) : t.settings.sessionUnavailable}</CardDescription>
          </CardHeader>
          <CardContent>
            <Button variant="destructive" className="w-full max-lg:min-h-11" onClick={signOut}><LogOut size={15} className="mr-2" />{t.settings.signOut}</Button>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>{t.settings.about}</CardTitle>
            <CardDescription>{t.settings.aboutDesc}</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">{t.settings.version}</span>
              <span className="text-sm font-medium">{t.settings.commit(__HYEB_GIT_COMMIT__)}</span>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
