'use client';

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { AlertTriangle, CheckCircle2, Loader2, Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

import { useAuth } from '@/hooks/use-auth';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import type { RoutingSummary } from '@/lib/routing/summary';
import { SettingsChip } from './settings-chip';
import { SettingsPanelHead } from './settings-panel-head';

interface Member {
  user_id: string;
  full_name: string | null;
  email: string | null;
  account_role: string;
}

interface RuleRow {
  id: string;
  kind: 'campaign_id' | 'name_contains';
  match_value: string;
  match_label: string | null;
  closer_id: string;
}

interface SettingsPayload {
  migrated: boolean;
  error?: string;
  enabled?: boolean;
  has_token?: boolean;
  last_error?: string | null;
  closers?: { user_id: string; receives_organic: boolean }[];
  rules?: RuleRow[];
  members?: Member[];
}

interface CampaignRow {
  id: string;
  name: string;
  status: string;
  adAccountName: string;
  closer_id: string | null;
  ambiguous: boolean;
}

type CloserDraft = Record<string, { isCloser: boolean; organic: boolean }>;

const STATS_DAYS = [7, 14, 30] as const;

async function api<T = Record<string, unknown>>(
  url: string,
  init?: RequestInit & { json?: unknown },
): Promise<{ ok: boolean; data: T & { error?: string } }> {
  const res = await fetch(url, {
    ...init,
    headers: init?.json !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: init?.json !== undefined ? JSON.stringify(init.json) : undefined,
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  return { ok: res.ok, data };
}

export function LeadRoutingSettings() {
  const t = useTranslations('Settings.leadRouting');
  const { canEditSettings, loading: authLoading, profileLoading } = useAuth();

  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<SettingsPayload | null>(null);
  const [draft, setDraft] = useState<CloserDraft>({});
  const [busy, setBusy] = useState<string | null>(null);

  const [token, setToken] = useState('');
  const [nameValue, setNameValue] = useState('');
  const [nameCloser, setNameCloser] = useState('');
  const [campaigns, setCampaigns] = useState<CampaignRow[] | null>(null);
  const [campaignsLoading, setCampaignsLoading] = useState(false);
  const [campaignId, setCampaignId] = useState('');
  const [campaignCloser, setCampaignCloser] = useState('');

  const [days, setDays] = useState<(typeof STATS_DAYS)[number]>(7);
  const [summary, setSummary] = useState<RoutingSummary | null>(null);

  const members = useMemo(() => data?.members ?? [], [data]);
  const rules = useMemo(() => data?.rules ?? [], [data]);
  const closers = useMemo(() => data?.closers ?? [], [data]);

  const nameOf = useCallback(
    (userId: string | null | undefined) => {
      const m = members.find((x) => x.user_id === userId);
      return m?.full_name?.trim() || m?.email || t('unknownCloser');
    },
    [members, t],
  );

  const closerMembers = useMemo(
    () => members.filter((m) => closers.some((c) => c.user_id === m.user_id)),
    [members, closers],
  );

  const load = useCallback(async () => {
    const { data: payload } = await api<SettingsPayload>('/api/routing/settings');
    setData(payload);
    if (payload.migrated) {
      const next: CloserDraft = {};
      for (const m of payload.members ?? []) {
        const c = payload.closers?.find((x) => x.user_id === m.user_id);
        next[m.user_id] = { isCloser: Boolean(c), organic: c ? c.receives_organic : true };
      }
      setDraft(next);
    }
  }, []);

  const loadStats = useCallback(async (d: number) => {
    const { ok, data: payload } = await api<{ migrated?: boolean; summary?: RoutingSummary }>(
      `/api/routing/stats?days=${d}`,
    );
    setSummary(ok && payload.migrated ? (payload.summary ?? null) : null);
  }, []);

  useEffect(() => {
    if (authLoading || profileLoading) return;
    if (!canEditSettings) {
      setLoading(false);
      return;
    }
    void (async () => {
      try {
        await load();
      } catch {
        toast.error(t('loadFailed'));
      } finally {
        setLoading(false);
      }
    })();
  }, [authLoading, profileLoading, canEditSettings, load, t]);

  useEffect(() => {
    if (data?.migrated) void loadStats(days);
  }, [data?.migrated, days, loadStats, rules.length, closers.length]);

  // ---- actions -----------------------------------------------------

  async function toggleEnabled(next: boolean) {
    if (next && closers.length === 0) {
      toast.error(t('enabledNeedsCloser'));
      return;
    }
    setBusy('enabled');
    const { ok, data: res } = await api('/api/routing/settings', { method: 'POST', json: { enabled: next } });
    setBusy(null);
    if (!ok) return void toast.error(res.error ?? t('loadFailed'));
    setData((d) => (d ? { ...d, enabled: next } : d));
    toast.success(t('enabledSaved'));
  }

  async function saveClosers() {
    setBusy('closers');
    const list = Object.entries(draft)
      .filter(([, v]) => v.isCloser)
      .map(([user_id, v]) => ({ user_id, receives_organic: v.organic }));
    const { ok, data: res } = await api('/api/routing/settings', { method: 'POST', json: { closers: list } });
    setBusy(null);
    if (!ok) return void toast.error(res.error ?? t('loadFailed'));
    toast.success(t('closersSaved'));
    await load();
  }

  async function saveToken() {
    if (!token.trim()) return;
    setBusy('token');
    const { ok, data: res } = await api<{ ad_accounts?: number }>('/api/routing/settings', {
      method: 'POST',
      json: { ads_access_token: token.trim() },
    });
    setBusy(null);
    if (!ok) return void toast.error(res.error ?? t('loadFailed'));
    toast.success(t('tokenSaved', { count: res.ad_accounts ?? 0 }));
    setToken('');
    setCampaigns(null);
    await load();
  }

  async function removeToken() {
    setBusy('token');
    const { ok, data: res } = await api('/api/routing/settings', { method: 'POST', json: { ads_access_token: null } });
    setBusy(null);
    if (!ok) return void toast.error(res.error ?? t('loadFailed'));
    toast.success(t('tokenRemoved'));
    setCampaigns(null);
    await load();
  }

  async function loadCampaigns() {
    setCampaignsLoading(true);
    const { ok, data: res } = await api<{ campaigns?: CampaignRow[] }>('/api/routing/campaigns');
    setCampaignsLoading(false);
    if (!ok) return void toast.error(res.error ?? t('loadFailed'));
    setCampaigns(res.campaigns ?? []);
  }

  async function addRule(body: { kind: RuleRow['kind']; match_value: string; match_label?: string; closer_id: string }) {
    setBusy('rule');
    const { ok, data: res } = await api('/api/routing/rules', { method: 'POST', json: body });
    setBusy(null);
    if (!ok) {
      toast.error(res.error ?? t('loadFailed'));
      return false;
    }
    toast.success(t('ruleAdded'));
    await load();
    return true;
  }

  async function deleteRule(id: string) {
    setBusy(`rule-${id}`);
    const { ok, data: res } = await api('/api/routing/rules', { method: 'DELETE', json: { id } });
    setBusy(null);
    if (!ok) return void toast.error(res.error ?? t('loadFailed'));
    toast.success(t('ruleDeleted'));
    await load();
  }

  async function addNameRule() {
    if (!nameValue.trim() || !nameCloser) return;
    if (await addRule({ kind: 'name_contains', match_value: nameValue.trim(), closer_id: nameCloser })) {
      setNameValue('');
    }
  }

  async function addCampaignRule() {
    const campaign = campaigns?.find((c) => c.id === campaignId);
    if (!campaign || !campaignCloser) return;
    if (await addRule({ kind: 'campaign_id', match_value: campaign.id, match_label: campaign.name, closer_id: campaignCloser })) {
      setCampaignId('');
      await loadCampaigns();
    }
  }

  // ---- render --------------------------------------------------------

  const head = <SettingsPanelHead title={t('title')} description={t('description')} />;

  if (loading) {
    return (
      <section className="animate-in fade-in-50 duration-200">
        {head}
        <div className="flex items-center justify-center py-12">
          <Loader2 className="size-6 animate-spin text-primary" />
        </div>
      </section>
    );
  }

  if (!canEditSettings) {
    return (
      <section className="animate-in fade-in-50 duration-200">
        {head}
        <p className="text-sm text-muted-foreground">{t('adminOnly')}</p>
      </section>
    );
  }

  if (!data?.migrated) {
    return (
      <section className="animate-in fade-in-50 duration-200">
        {head}
        <Notice tone="warn">{data?.error ?? t('migrationNeeded')}</Notice>
      </section>
    );
  }

  const draftChanged =
    members.some((m) => {
      const d = draft[m.user_id];
      const c = closers.find((x) => x.user_id === m.user_id);
      return Boolean(d?.isCloser) !== Boolean(c) || (d?.isCloser && c && d.organic !== c.receives_organic);
    });

  const closerOptions = closerMembers.map((m) => ({ value: m.user_id, label: nameOf(m.user_id) }));

  return (
    <section className="animate-in fade-in-50 space-y-6 duration-200">
      {head}

      {/* Master switch */}
      <Card>
        <CardContent className="flex items-center justify-between gap-4">
          <div>
            <p className="text-sm font-medium text-foreground">{t('enabledTitle')}</p>
            <p className="text-xs text-muted-foreground">{t('enabledDesc')}</p>
          </div>
          <Switch
            checked={data.enabled === true}
            onCheckedChange={toggleEnabled}
            disabled={busy === 'enabled'}
            aria-label={t('enabledTitle')}
          />
        </CardContent>
      </Card>

      {/* Closers */}
      <Card>
        <CardHeader>
          <CardTitle>{t('closersTitle')}</CardTitle>
          <CardDescription>{t('closersDesc')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {members.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('noMembers')}</p>
          ) : (
            members.map((m) => {
              const d = draft[m.user_id] ?? { isCloser: false, organic: true };
              return (
                <div
                  key={m.user_id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border p-3"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-foreground">{nameOf(m.user_id)}</p>
                    {m.email && <p className="truncate text-xs text-muted-foreground">{m.email}</p>}
                  </div>
                  <div className="flex flex-wrap items-center gap-5">
                    <label className="flex items-center gap-2 text-xs text-muted-foreground">
                      <Switch
                        checked={d.isCloser}
                        onCheckedChange={(v) => setDraft((p) => ({ ...p, [m.user_id]: { ...d, isCloser: v } }))}
                      />
                      {t('closerReceives')}
                    </label>
                    <label className="flex items-center gap-2 text-xs text-muted-foreground">
                      <Switch
                        checked={d.isCloser && d.organic}
                        disabled={!d.isCloser}
                        onCheckedChange={(v) => setDraft((p) => ({ ...p, [m.user_id]: { ...d, organic: v } }))}
                      />
                      {t('closerOrganic')}
                    </label>
                  </div>
                </div>
              );
            })
          )}
          <Button onClick={saveClosers} disabled={busy === 'closers' || !draftChanged}>
            {busy === 'closers' && <Loader2 className="size-4 animate-spin" />}
            {t('closersSave')}
          </Button>
        </CardContent>
      </Card>

      {/* Meta connection */}
      <Card>
        <CardHeader>
          <CardTitle>{t('metaTitle')}</CardTitle>
          <CardDescription>{t('metaDesc')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {data.last_error && <Notice tone="warn">{t('lastError', { message: data.last_error })}</Notice>}
          <div className="space-y-1.5">
            <Label htmlFor="routing-token">{t('tokenLabel')}</Label>
            <Input
              id="routing-token"
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder={t('tokenPlaceholder')}
              autoComplete="off"
            />
            {data.has_token && !token && (
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <CheckCircle2 className="size-3.5 text-emerald-500" />
                {t('tokenHidden')}
              </p>
            )}
          </div>
          <p
            className="text-xs leading-relaxed text-muted-foreground"
            dangerouslySetInnerHTML={{ __html: t.raw('tokenHelp') as string }}
          />
          <div className="flex flex-wrap gap-2">
            <Button onClick={saveToken} disabled={busy === 'token' || !token.trim()}>
              {busy === 'token' && <Loader2 className="size-4 animate-spin" />}
              {t('tokenSave')}
            </Button>
            {data.has_token && (
              <Button variant="outline" onClick={removeToken} disabled={busy === 'token'}>
                {t('tokenRemove')}
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Rules */}
      <Card>
        <CardHeader>
          <CardTitle>{t('rulesTitle')}</CardTitle>
          <CardDescription>{t('rulesDesc')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {rules.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('rulesEmpty')}</p>
          ) : (
            <ul className="space-y-2">
              {rules.map((r) => (
                <li
                  key={r.id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border p-3"
                >
                  <div className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
                    <SettingsChip variant={r.kind === 'name_contains' ? 'admin' : 'muted'}>
                      {r.kind === 'name_contains' ? t('ruleByName') : t('ruleByCampaign')}
                    </SettingsChip>
                    <span className="truncate font-medium text-foreground">
                      {r.kind === 'campaign_id' ? (r.match_label ?? r.match_value) : `“${r.match_value}”`}
                    </span>
                    <span className="text-muted-foreground">→</span>
                    <span className="font-medium text-foreground">{nameOf(r.closer_id)}</span>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={t('ruleDelete')}
                    onClick={() => deleteRule(r.id)}
                    disabled={busy === `rule-${r.id}`}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </li>
              ))}
            </ul>
          )}

          <div className="grid gap-5 lg:grid-cols-2">
            {/* By name */}
            <div className="space-y-3 rounded-md border border-border p-3">
              <p className="text-sm font-medium text-foreground">{t('addByNameTitle')}</p>
              <div className="space-y-1.5">
                <Label htmlFor="routing-name">{t('nameLabel')}</Label>
                <Input
                  id="routing-name"
                  value={nameValue}
                  onChange={(e) => setNameValue(e.target.value)}
                  placeholder={t('namePlaceholder')}
                />
                <p className="text-xs text-muted-foreground">{t('nameHint')}</p>
              </div>
              <CloserSelect
                id="routing-name-closer"
                label={t('pickCloser')}
                placeholder={t('pickCloserPlaceholder')}
                value={nameCloser}
                options={closerOptions}
                onChange={setNameCloser}
              />
              <Button onClick={addNameRule} disabled={busy === 'rule' || !nameValue.trim() || !nameCloser}>
                {t('addRule')}
              </Button>
            </div>

            {/* By exact campaign */}
            <div className="space-y-3 rounded-md border border-border p-3">
              <p className="text-sm font-medium text-foreground">{t('addByCampaignTitle')}</p>
              {campaigns === null ? (
                <Button variant="outline" onClick={loadCampaigns} disabled={campaignsLoading || !data.has_token}>
                  {campaignsLoading && <Loader2 className="size-4 animate-spin" />}
                  {campaignsLoading ? t('campaignsLoading') : t('loadCampaigns')}
                </Button>
              ) : campaigns.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t('campaignsNone')}</p>
              ) : (
                <>
                  <CloserSelect
                    id="routing-campaign"
                    label={t('campaignLabel')}
                    placeholder={t('campaignPlaceholder')}
                    value={campaignId}
                    options={campaigns.map((c) => ({
                      value: c.id,
                      label: `${c.name}${c.closer_id ? ` · ${t('campaignMapped')}` : ''}`,
                    }))}
                    onChange={setCampaignId}
                  />
                  <CloserSelect
                    id="routing-campaign-closer"
                    label={t('pickCloser')}
                    placeholder={t('pickCloserPlaceholder')}
                    value={campaignCloser}
                    options={closerOptions}
                    onChange={setCampaignCloser}
                  />
                  <Button onClick={addCampaignRule} disabled={busy === 'rule' || !campaignId || !campaignCloser}>
                    {t('addRule')}
                  </Button>
                </>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Summary */}
      <Card>
        <CardHeader>
          <CardTitle>{t('summaryTitle')}</CardTitle>
          <div className="flex flex-wrap gap-1.5 pt-1">
            {STATS_DAYS.map((d) => (
              <Button key={d} size="sm" variant={d === days ? 'default' : 'outline'} onClick={() => setDays(d)}>
                {t('summaryDays', { days: d })}
              </Button>
            ))}
          </div>
        </CardHeader>
        <CardContent className="space-y-5">
          {!summary || summary.total === 0 ? (
            <p className="text-sm text-muted-foreground">{t('summaryNoData')}</p>
          ) : (
            <>
              <div>
                {summary.adRoutedPct === null ? (
                  <p className="text-sm text-muted-foreground">{t('summaryNoAds')}</p>
                ) : (
                  <>
                    <p className="text-sm font-medium text-foreground">
                      {t('summaryAdPct', {
                        pct: summary.adRoutedPct,
                        routed: summary.adLeadsRouted,
                        total: summary.adLeads,
                      })}
                    </p>
                    <p className="mt-0.5 text-xs text-muted-foreground">{t('summaryPctHint')}</p>
                  </>
                )}
              </div>

              {summary.byOwner.length > 0 && (
                <div className="space-y-2">
                  <p className="text-sm font-medium text-foreground">{t('byCloserTitle')}</p>
                  <div className="overflow-x-auto rounded-md border border-border">
                    <table className="w-full text-sm">
                      <thead className="bg-muted/50 text-xs text-muted-foreground">
                        <tr>
                          <th className="px-3 py-2 text-left font-medium">{t('colCloser')}</th>
                          <th className="px-3 py-2 text-right font-medium">{t('colFromCampaign')}</th>
                          <th className="px-3 py-2 text-right font-medium">{t('colOther')}</th>
                          <th className="px-3 py-2 text-right font-medium">{t('colTotal')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {summary.byOwner.map((o) => (
                          <tr key={o.ownerId} className="border-t border-border">
                            <td className="px-3 py-2 text-foreground">{nameOf(o.ownerId)}</td>
                            <td className="px-3 py-2 text-right tabular-nums">{o.fromCampaign}</td>
                            <td className="px-3 py-2 text-right tabular-nums">{o.other}</td>
                            <td className="px-3 py-2 text-right font-medium tabular-nums">{o.total}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              <div className="space-y-2">
                <p className="text-sm font-medium text-foreground">{t('sourcesTitle')}</p>
                <ul className="grid gap-1 text-sm sm:grid-cols-2">
                  {(
                    [
                      ['campaign', t('sourceCampaign')],
                      ['unmatched_campaign', t('sourceUnmatched')],
                      ['unresolved', t('sourceUnresolved')],
                      ['organic', t('sourceOrganic')],
                      ['manual', t('sourceManual')],
                      ['none', t('sourceNone')],
                    ] as const
                  )
                    .filter(([key]) => (summary.bySource[key] ?? 0) > 0)
                    .map(([key, label]) => (
                      <li key={key} className="flex justify-between gap-3 text-muted-foreground">
                        <span>{label}</span>
                        <span className="font-medium tabular-nums text-foreground">{summary.bySource[key]}</span>
                      </li>
                    ))}
                </ul>
              </div>

              {summary.campaigns.length > 0 && (
                <div className="space-y-2">
                  <div>
                    <p className="text-sm font-medium text-foreground">{t('campaignsSeenTitle')}</p>
                    <p className="text-xs text-muted-foreground">{t('campaignsSeenHint')}</p>
                  </div>
                  <ul className="space-y-2">
                    {summary.campaigns.map((c) => (
                      <SeenCampaign
                        key={c.id}
                        name={c.name ?? t('unnamedCampaign')}
                        leads={t('leadsCount', { count: c.leads })}
                        coverageLabel={
                          c.coverage === 'id'
                            ? t('coverageId')
                            : c.coverage === 'name'
                              ? t('coverageName')
                              : c.coverage === 'ambiguous'
                                ? t('coverageAmbiguous')
                                : t('coverageNone')
                        }
                        covered={c.coverage === 'id' || c.coverage === 'name'}
                        closerName={c.closerId ? nameOf(c.closerId) : null}
                        closerOptions={closerOptions}
                        pickPlaceholder={t('pickCloserPlaceholder')}
                        assignLabel={t('assign')}
                        busy={busy === 'rule'}
                        onAssign={(closerId) =>
                          addRule({ kind: 'campaign_id', match_value: c.id, match_label: c.name ?? undefined, closer_id: closerId })
                        }
                      />
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </section>
  );
}

// ---------------------------------------------------------------------

function Notice({ tone, children }: { tone: 'warn'; children: ReactNode }) {
  void tone;
  return (
    <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-300">
      <AlertTriangle className="mt-0.5 size-4 shrink-0" />
      <div>{children}</div>
    </div>
  );
}

function CloserSelect({
  id,
  label,
  placeholder,
  value,
  options,
  onChange,
}: {
  id: string;
  label: string;
  placeholder: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
}) {
  const selected = options.find((o) => o.value === value);
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Select value={value} onValueChange={(v) => v && onChange(v)}>
        <SelectTrigger id={id} className="w-full">
          <SelectValue>
            {selected ? selected.label : <span className="text-muted-foreground">{placeholder}</span>}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function SeenCampaign({
  name,
  leads,
  coverageLabel,
  covered,
  closerName,
  closerOptions,
  pickPlaceholder,
  assignLabel,
  busy,
  onAssign,
}: {
  name: string;
  leads: string;
  coverageLabel: string;
  covered: boolean;
  closerName: string | null;
  closerOptions: { value: string; label: string }[];
  pickPlaceholder: string;
  assignLabel: string;
  busy: boolean;
  onAssign: (closerId: string) => Promise<boolean>;
}) {
  const [closer, setCloser] = useState('');
  const selected = closerOptions.find((o) => o.value === closer);
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border p-3">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-foreground">{name}</p>
        <p className="text-xs text-muted-foreground">{leads}</p>
      </div>
      {covered ? (
        <SettingsChip variant="ok">
          {coverageLabel}
          {closerName ? ` → ${closerName}` : ''}
        </SettingsChip>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <SettingsChip variant="warn">{coverageLabel}</SettingsChip>
          <Select value={closer} onValueChange={(v) => v && setCloser(v)}>
            <SelectTrigger className="w-44">
              <SelectValue>
                {selected ? selected.label : <span className="text-muted-foreground">{pickPlaceholder}</span>}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {closerOptions.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button size="sm" disabled={busy || !closer} onClick={() => void onAssign(closer)}>
            {assignLabel}
          </Button>
        </div>
      )}
    </li>
  );
}
