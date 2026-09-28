'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import type { ConversationStatus, Tag } from '@/types';
import { useCan } from '@/hooks/use-can';
import { GatedButton } from '@/components/ui/gated-button';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Checkbox } from '@/components/ui/checkbox';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import {
  Search,
  Filter,
  X,
  Download,
  Loader2,
  ChevronLeft,
  ChevronRight,
  Inbox as InboxIcon,
} from 'lucide-react';
import {
  buildExportFile,
  downloadTextFile,
  exportFileName,
  type ExportFormat,
  type ExportLabels,
} from '@/lib/exports/format';
import { MAX_EXPORT_BATCH } from '@/lib/exports/rows';
import type { ExportConversation } from '@/lib/exports/types';

const PAGE_SIZE = 25;
// Convenience cap for "select every conversation matching this filter" —
// above this the filter should be narrowed instead of pulling a huge
// selection in one click.
const MAX_SELECT_ALL = 500;

interface PickerRow {
  conversation_id: string;
  status: ConversationStatus;
  last_message_at: string | null;
  last_message_text: string | null;
  contact_id: string;
  contact_name: string | null;
  contact_phone: string;
  contact_company: string | null;
  tag_ids: string[];
}

const STATUS_OPTIONS: { value: ConversationStatus | 'all'; key: string }[] = [
  { value: 'all', key: 'filterAll' },
  { value: 'open', key: 'filterOpen' },
  { value: 'pending', key: 'filterPending' },
  { value: 'closed', key: 'filterClosed' },
];

export default function ExportsPage() {
  const t = useTranslations('Exports');
  const supabase = createClient();
  const canExport = useCan('edit-settings');

  const [rows, setRows] = useState<PickerRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(0);
  const [totalCount, setTotalCount] = useState(0);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<ConversationStatus | 'all'>('all');
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);
  const [tagsMap, setTagsMap] = useState<Record<string, Tag>>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [selectingAll, setSelectingAll] = useState(false);

  const [exportOpen, setExportOpen] = useState(false);
  const [format, setFormat] = useState<ExportFormat>('csv');
  const [exporting, setExporting] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });

  const fetchSeq = useRef(0);

  const fetchTags = useCallback(async () => {
    const { data } = await supabase.from('tags').select('*');
    if (data) {
      const map: Record<string, Tag> = {};
      data.forEach((tag) => (map[tag.id] = tag));
      setTagsMap(map);
    }
  }, [supabase]);

  const fetchRows = useCallback(async () => {
    const seq = ++fetchSeq.current;
    setLoading(true);
    const { data, error } = await supabase.rpc('search_export_conversations', {
      p_tag_ids: selectedTagIds.length > 0 ? selectedTagIds : null,
      p_search: search.trim() || null,
      p_status: statusFilter === 'all' ? null : statusFilter,
      p_limit: PAGE_SIZE,
      p_offset: page * PAGE_SIZE,
    });
    if (seq !== fetchSeq.current) return;
    if (error) {
      toast.error(t('loadFailed'));
      setLoading(false);
      return;
    }
    const list = (data ?? []) as (PickerRow & { total_count: number })[];
    setRows(list);
    setTotalCount(list.length > 0 ? Number(list[0].total_count) : 0);
    setLoading(false);
  }, [supabase, page, search, statusFilter, selectedTagIds, t]);

  useEffect(() => {
    void fetchTags();
  }, [fetchTags]);

  useEffect(() => {
    void fetchRows();
  }, [fetchRows]);

  const allTags = useMemo(
    () => Object.values(tagsMap).sort((a, b) => a.name.localeCompare(b.name)),
    [tagsMap],
  );

  function toggleTagFilter(tagId: string) {
    setSelectedTagIds((prev) =>
      prev.includes(tagId) ? prev.filter((id) => id !== tagId) : [...prev, tagId],
    );
    setPage(0);
  }

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const allOnPageSelected = rows.length > 0 && rows.every((r) => selected.has(r.conversation_id));
  const someOnPageSelected = rows.some((r) => selected.has(r.conversation_id));

  function toggleSelectAllOnPage() {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allOnPageSelected) {
        rows.forEach((r) => next.delete(r.conversation_id));
      } else {
        rows.forEach((r) => next.add(r.conversation_id));
      }
      return next;
    });
  }

  async function selectAllMatching() {
    setSelectingAll(true);
    try {
      const { data, error } = await supabase.rpc('search_export_conversations', {
        p_tag_ids: selectedTagIds.length > 0 ? selectedTagIds : null,
        p_search: search.trim() || null,
        p_status: statusFilter === 'all' ? null : statusFilter,
        p_limit: MAX_SELECT_ALL,
        p_offset: 0,
      });
      if (error) {
        toast.error(t('loadFailed'));
        return;
      }
      const ids = ((data ?? []) as { conversation_id: string }[]).map((r) => r.conversation_id);
      setSelected(new Set(ids));
      toast.success(t('selectedAllToast', { count: ids.length }));
    } finally {
      setSelectingAll(false);
    }
  }

  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));

  const labels: ExportLabels = useMemo(
    () => ({
      headers: [
        t('col.conversationId'),
        t('col.contact'),
        t('col.phone'),
        t('col.company'),
        t('col.tags'),
        t('col.chatStatus'),
        t('col.direction'),
        t('col.sender'),
        t('col.contentType'),
        t('col.message'),
        t('col.mediaUrl'),
        t('col.template'),
        t('col.messageStatus'),
        t('col.timestamp'),
      ],
      direction: { received: t('directionReceived'), sent: t('directionSent') },
      sender: { customer: t('senderCustomer'), agent: t('senderAgent'), bot: t('senderBot') },
      unnamed: t('unnamedContact'),
      noMessages: t('noMessagesInChat'),
    }),
    [t],
  );

  async function runExport() {
    const ids = [...selected];
    if (ids.length === 0) return;
    setExporting(true);
    setProgress({ done: 0, total: ids.length });
    const collected: ExportConversation[] = [];
    try {
      for (let i = 0; i < ids.length; i += MAX_EXPORT_BATCH) {
        const batch = ids.slice(i, i + MAX_EXPORT_BATCH);
        const res = await fetch('/api/exports/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ conversation_ids: batch }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          toast.error(data.error ?? t('exportFailed'));
          return;
        }
        collected.push(...((data.conversations ?? []) as ExportConversation[]));
        setProgress({ done: Math.min(i + batch.length, ids.length), total: ids.length });
      }

      if (collected.length === 0) {
        toast.error(t('exportFailed'));
        return;
      }
      const { content, mimeType } = buildExportFile(format, collected, labels);
      downloadTextFile(exportFileName(format), content, mimeType);
      toast.success(t('exportSuccess', { count: collected.length }));
      if (collected.length < ids.length) {
        toast.warning(t('exportPartial', { got: collected.length, wanted: ids.length }));
      }
      setExportOpen(false);
      setSelected(new Set());
    } catch {
      toast.error(t('exportFailed'));
    } finally {
      setExporting(false);
    }
  }

  const hasActiveFilters = search.trim().length > 0 || selectedTagIds.length > 0 || statusFilter !== 'all';

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">{t('title')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t('subtitle')}</p>
      </div>

      {!canExport && (
        <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
          {t('adminOnly')}
        </p>
      )}

      {/* Filters */}
      <div className="space-y-2">
        <div className="flex flex-col gap-2 sm:flex-row">
          <div className="relative w-full max-w-sm">
            <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(0);
              }}
              placeholder={t('searchPlaceholder')}
              className="border-border bg-card pl-8 text-foreground placeholder:text-muted-foreground"
            />
          </div>

          <div className="flex flex-wrap items-center gap-1 rounded-lg bg-muted/60 p-1">
            {STATUS_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() => {
                  setStatusFilter(opt.value);
                  setPage(0);
                }}
                className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                  statusFilter === opt.value
                    ? 'bg-secondary text-secondary-foreground'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {t(opt.key as never)}
              </button>
            ))}
          </div>

          <Popover>
            <PopoverTrigger
              render={<Button variant="outline" className="shrink-0 border-border text-muted-foreground hover:bg-muted" />}
            >
              <Filter className="size-4" />
              {t('filterByTags')}
              {selectedTagIds.length > 0 && (
                <span className="ml-1 inline-flex items-center justify-center rounded-full bg-primary px-1.5 text-[10px] font-semibold text-primary-foreground">
                  {selectedTagIds.length}
                </span>
              )}
            </PopoverTrigger>
            <PopoverContent align="start" className="w-64 p-0">
              <div className="flex items-center justify-between border-b border-border px-3 py-2">
                <span className="text-sm font-medium text-popover-foreground">{t('filterByTags')}</span>
                {selectedTagIds.length > 0 && (
                  <button onClick={() => setSelectedTagIds([])} className="text-xs text-muted-foreground hover:text-foreground">
                    {t('clearAll')}
                  </button>
                )}
              </div>
              {allTags.length === 0 ? (
                <p className="px-3 py-4 text-center text-sm text-muted-foreground">{t('noTagsYet')}</p>
              ) : (
                <div className="max-h-64 overflow-y-auto py-1">
                  {allTags.map((tag) => (
                    <label key={tag.id} className="flex cursor-pointer items-center gap-2.5 px-3 py-1.5 hover:bg-muted/50">
                      <Checkbox checked={selectedTagIds.includes(tag.id)} onCheckedChange={() => toggleTagFilter(tag.id)} />
                      <span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: tag.color }} />
                      <span className="truncate text-sm text-popover-foreground">{tag.name}</span>
                    </label>
                  ))}
                </div>
              )}
            </PopoverContent>
          </Popover>
        </div>

        {selectedTagIds.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            {selectedTagIds.map((id) => {
              const tag = tagsMap[id];
              if (!tag) return null;
              return (
                <span
                  key={id}
                  className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium"
                  style={{ backgroundColor: tag.color + '20', color: tag.color }}
                >
                  {tag.name}
                  <button onClick={() => toggleTagFilter(id)} className="hover:opacity-70">
                    <X className="size-3" />
                  </button>
                </span>
              );
            })}
          </div>
        )}
      </div>

      {/* Selection bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-muted/30 px-4 py-2.5">
        <p className="text-sm text-foreground">
          {selected.size > 0 ? t('selectedCount', { count: selected.size }) : t('noneSelected')}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          {totalCount > rows.length && totalCount <= MAX_SELECT_ALL && (
            <Button variant="ghost" size="sm" onClick={selectAllMatching} disabled={selectingAll} className="text-muted-foreground hover:text-foreground">
              {selectingAll && <Loader2 className="size-3.5 animate-spin" />}
              {t('selectAllMatching', { count: totalCount })}
            </Button>
          )}
          {selected.size > 0 && (
            <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())} className="text-muted-foreground hover:text-foreground">
              {t('clearSelection')}
            </Button>
          )}
          <GatedButton
            size="sm"
            canAct={canExport}
            gateReason="export chats"
            disabled={selected.size === 0}
            onClick={() => setExportOpen(true)}
          >
            <Download className="size-4" />
            {t('exportSelected', { count: selected.size })}
          </GatedButton>
        </div>
      </div>

      {/* Table */}
      <div className="overflow-hidden rounded-lg border border-border">
        <Table>
          <TableHeader>
            <TableRow className="border-border hover:bg-transparent">
              <TableHead className="w-10">
                <Checkbox
                  checked={allOnPageSelected}
                  indeterminate={!allOnPageSelected && someOnPageSelected}
                  onCheckedChange={toggleSelectAllOnPage}
                  disabled={rows.length === 0 || !canExport}
                  className="border-muted-foreground/60"
                />
              </TableHead>
              <TableHead className="text-muted-foreground">{t('col.contact')}</TableHead>
              <TableHead className="text-muted-foreground">{t('col.phone')}</TableHead>
              <TableHead className="hidden text-muted-foreground lg:table-cell">{t('col.company')}</TableHead>
              <TableHead className="hidden text-muted-foreground md:table-cell">{t('col.tags')}</TableHead>
              <TableHead className="text-muted-foreground">{t('col.chatStatus')}</TableHead>
              <TableHead className="hidden text-muted-foreground lg:table-cell">{t('lastActivity')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow className="border-border">
                <TableCell colSpan={7} className="py-12 text-center">
                  <div className="flex flex-col items-center gap-2">
                    <Loader2 className="size-6 animate-spin text-primary" />
                    <p className="text-sm text-muted-foreground">{t('loading')}</p>
                  </div>
                </TableCell>
              </TableRow>
            ) : rows.length === 0 ? (
              <TableRow className="border-border">
                <TableCell colSpan={7} className="py-12 text-center">
                  <div className="flex flex-col items-center gap-2">
                    <InboxIcon className="size-8 text-muted-foreground" />
                    <p className="text-sm text-muted-foreground">
                      {hasActiveFilters ? t('noChatsMatch') : t('noChatsYet')}
                    </p>
                  </div>
                </TableCell>
              </TableRow>
            ) : (
              rows.map((row) => {
                const displayName = row.contact_name?.trim() || row.contact_phone;
                return (
                  <TableRow
                    key={row.conversation_id}
                    className="cursor-pointer border-border hover:bg-muted/50"
                    onClick={() => canExport && toggleSelect(row.conversation_id)}
                  >
                    <TableCell onClick={(e) => e.stopPropagation()}>
                      <Checkbox
                        checked={selected.has(row.conversation_id)}
                        onCheckedChange={() => toggleSelect(row.conversation_id)}
                        disabled={!canExport}
                        className="border-muted-foreground/60"
                      />
                    </TableCell>
                    <TableCell className="font-medium text-foreground">{displayName}</TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">{row.contact_phone}</TableCell>
                    <TableCell className="hidden text-sm text-muted-foreground lg:table-cell">
                      {row.contact_company || <span className="text-muted-foreground">-</span>}
                    </TableCell>
                    <TableCell className="hidden md:table-cell">
                      <div className="flex flex-wrap gap-1">
                        {row.tag_ids.length === 0 ? (
                          <span className="text-xs text-muted-foreground">-</span>
                        ) : (
                          row.tag_ids.slice(0, 2).map((id) => {
                            const tag = tagsMap[id];
                            if (!tag) return null;
                            return (
                              <span
                                key={id}
                                className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium"
                                style={{ backgroundColor: tag.color + '20', color: tag.color }}
                              >
                                {tag.name}
                              </span>
                            );
                          })
                        )}
                        {row.tag_ids.length > 2 && (
                          <span className="text-[10px] text-muted-foreground">+{row.tag_ids.length - 2}</span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">{t(`filter${capitalize(row.status)}` as never)}</TableCell>
                    <TableCell className="hidden text-xs text-muted-foreground lg:table-cell">
                      {row.last_message_at ? new Date(row.last_message_at).toLocaleString() : '-'}
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-xs text-muted-foreground">
            {t('showingPagination', {
              start: page * PAGE_SIZE + 1,
              end: Math.min((page + 1) * PAGE_SIZE, totalCount),
              total: totalCount,
            })}
          </p>
          <div className="flex items-center gap-1">
            <Button
              variant="outline"
              size="icon-sm"
              disabled={page === 0}
              onClick={() => setPage((p) => p - 1)}
              className="border-border text-muted-foreground hover:bg-muted disabled:opacity-30"
            >
              <ChevronLeft className="size-4" />
            </Button>
            <span className="px-2 text-xs text-muted-foreground">{t('pageCount', { page: page + 1, total: totalPages })}</span>
            <Button
              variant="outline"
              size="icon-sm"
              disabled={page >= totalPages - 1}
              onClick={() => setPage((p) => p + 1)}
              className="border-border text-muted-foreground hover:bg-muted disabled:opacity-30"
            >
              <ChevronRight className="size-4" />
            </Button>
          </div>
        </div>
      )}

      {/* Export dialog */}
      <Dialog open={exportOpen} onOpenChange={(o) => !exporting && setExportOpen(o)}>
        <DialogContent className="border-border bg-popover text-popover-foreground sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-popover-foreground">{t('exportDialogTitle')}</DialogTitle>
            <DialogDescription className="text-muted-foreground">
              {t('exportDialogDesc', { count: selected.size })}
            </DialogDescription>
          </DialogHeader>

          {exporting ? (
            <div className="space-y-2 py-2">
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full bg-primary transition-all"
                  style={{ width: `${progress.total > 0 ? (progress.done / progress.total) * 100 : 0}%` }}
                />
              </div>
              <p className="text-center text-xs text-muted-foreground">
                {t('exportingProgress', { done: progress.done, total: progress.total })}
              </p>
            </div>
          ) : (
            <RadioGroup value={format} onValueChange={(v) => v && setFormat(v as ExportFormat)} className="py-1">
              <label className="flex cursor-pointer items-start gap-3 rounded-md border border-border p-3 has-data-checked:border-primary">
                <RadioGroupItem value="csv" className="mt-0.5" />
                <span>
                  <span className="block text-sm font-medium text-foreground">{t('formatCsv')}</span>
                  <span className="block text-xs text-muted-foreground">{t('formatCsvHint')}</span>
                </span>
              </label>
              <label className="flex cursor-pointer items-start gap-3 rounded-md border border-border p-3 has-data-checked:border-primary">
                <RadioGroupItem value="txt" className="mt-0.5" />
                <span>
                  <span className="block text-sm font-medium text-foreground">{t('formatTxt')}</span>
                  <span className="block text-xs text-muted-foreground">{t('formatTxtHint')}</span>
                </span>
              </label>
            </RadioGroup>
          )}

          <DialogFooter className="border-border bg-popover">
            <Button variant="outline" onClick={() => setExportOpen(false)} disabled={exporting} className="border-border text-muted-foreground hover:bg-muted">
              {t('cancel')}
            </Button>
            <Button onClick={runExport} disabled={exporting}>
              {exporting && <Loader2 className="size-4 animate-spin" />}
              {t('confirmExport')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
