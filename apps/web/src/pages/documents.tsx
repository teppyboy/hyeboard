import type { DocumentItem, ServiceRequest } from "@hyeboard/schemas";
import { ChevronDown } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Empty, FeatureHeader, FeedItem, StatusBadge } from "@/components/shared";
import { api } from "@/lib/api";
import { useLocale } from "@/lib/i18n";
import { cn, formatDateTime } from "@/lib/utils";
import { useFeatureQuery, useHyeboard } from "@/state";

function UnsupportedPanel({ title }: { title: string }) {
  const { t } = useLocale();
  return (
    <Card className="animate-card">
      <CardHeader><CardTitle>{title}</CardTitle></CardHeader>
      <CardContent><p className="text-sm text-muted-foreground">{t.documents.notSupported}</p></CardContent>
    </Card>
  );
}

function MiniPanel<T>({ title, query, children }: { title: string; query: { data?: T[]; error: Error | null; isLoading: boolean }; children: (data: T[]) => ReactNode }) {
  const { t } = useLocale();
  const [open, setOpen] = useState(true);
  return (
    <Card className="animate-card">
      <CardHeader className="pb-3">
        <button type="button" className="flex w-full items-center justify-between gap-3 text-left" onClick={() => setOpen((value) => !value)} aria-expanded={open} aria-label={t.documents.toggle(title)}>
          <CardTitle className="text-base">{title}</CardTitle>
          <ChevronDown className={cn("h-4 w-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")} />
        </button>
      </CardHeader>
      <div className="collapsible-panel" data-open={open}>
        <div>
          <CardContent className="divide-y divide-border pt-0">{query.isLoading ? <Skeleton className="h-24" /> : query.error ? <p className="py-2 text-sm text-muted-foreground">{query.error.message}</p> : query.data?.length ? children(query.data) : <Empty text={t.common.noItemsYet} />}</CardContent>
        </div>
      </div>
    </Card>
  );
}

function DocumentRow({ item }: { item: DocumentItem }) {
  const { t } = useLocale();
  return <FeedItem title={item.name} detail={`${item.courseCode ?? t.common.document}${item.updatedAt ? ` · ${formatDateTime(item.updatedAt)}` : ""}`} url={item.url} />;
}

function RequestRow({ item }: { item: ServiceRequest }) {
  const { t } = useLocale();
  return <FeedItem title={item.title} detail={item.status ? <StatusBadge value={item.status} /> : (item.type ?? t.common.request)} />;
}

export function DocumentsPage() {
  const state = useHyeboard();
  const { t } = useLocale();
  const capabilities = state.universities.data?.find((u) => u.id === state.universityId)?.capabilities;
  const showDocuments = capabilities?.documents ?? true;
  const showNews = capabilities?.news ?? true;
  const showRequests = capabilities?.requests ?? true;
  const [docSearch, setDocSearch] = useState("");

  const docs = useFeatureQuery("documents", () => api.documents(state.universityId), { enabled: showDocuments });
  const news = useFeatureQuery("news", () => api.news(state.universityId), { enabled: showNews });
  const requests = useFeatureQuery("requests", () => api.requests(state.universityId), { enabled: showRequests });
  const filteredDocs = docSearch.trim()
    ? docs.data?.filter((item) => `${item.name} ${item.courseCode ?? ""}`.toLowerCase().includes(docSearch.trim().toLowerCase()))
    : docs.data;

  return (
    <div className="space-y-4">
      <FeatureHeader title={t.documents.title} description={t.documents.description} />
      <div className="grid gap-4 xl:grid-cols-2">
        {showDocuments ? (
          <div className="space-y-2">
            <Input value={docSearch} onChange={(event) => setDocSearch(event.target.value)} placeholder={t.documents.searchPlaceholder} aria-label={t.documents.searchAriaLabel} />
            <MiniPanel title={t.documents.documentsTitle} query={{ ...docs, data: filteredDocs }}>{(items) => items.map((item) => <DocumentRow key={item.id} item={item} />)}</MiniPanel>
          </div>
        ) : <UnsupportedPanel title={t.documents.documentsTitle} />}
        {showNews ? <MiniPanel title={t.documents.news} query={news}>{(items) => items.map((item) => <FeedItem key={item.id} title={item.title} detail={item.category ?? item.date ?? t.common.news} url={item.url} />)}</MiniPanel> : <UnsupportedPanel title={t.documents.news} />}
        {showRequests ? <MiniPanel title={t.documents.requests} query={requests}>{(items) => items.map((item) => <RequestRow key={item.id} item={item} />)}</MiniPanel> : <UnsupportedPanel title={t.documents.requests} />}
      </div>
    </div>
  );
}
