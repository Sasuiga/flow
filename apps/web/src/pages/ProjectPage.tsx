import { ChevronRight, Plus, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { AutoComplete } from 'antd';
import { CreateEntityInput, FundUse, ProjectAccount, ProjectView, TaskView } from '@flow/shared';
import { api, ProjectDetail as ProjectDetailData } from '../api';
import { CreateDialog } from '../components/CreateDialog';
import { ListRow, ListRowHeader } from '../components/ListRow';
import { Modal } from '../components/Modal';
import { confirmDialog } from '../lib/confirm';
import { formatDate } from '../lib/format';

function filledChoices(values: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  for (const raw of values) {
    const v = raw?.trim();
    if (v) seen.add(v);
  }
  return [...seen].sort((a, b) => a.localeCompare(b, 'zh'));
}

function SuggestInput({
  value,
  onChange,
  choices,
  autoFocus,
}: {
  value: string;
  onChange: (value: string) => void;
  choices: string[];
  autoFocus?: boolean;
}) {
  return (
    <AutoComplete
      className="acct-combo"
      value={value}
      autoFocus={autoFocus}
      options={choices.map((v) => ({ value: v }))}
      onChange={onChange}
      filterOption={(input, option) =>
        String(option?.value ?? '')
          .toLocaleLowerCase()
          .includes(input.trim().toLocaleLowerCase())
      }
      styles={{ popup: { root: { zIndex: 2000 } } }}
    />
  );
}

type ProjectPageProps = {
  projectId: number;
  onBackToClient: (clientId: number) => void;
  onOpenTask: (id: number) => void;
};

export function ProjectPage({ projectId, onBackToClient, onOpenTask }: ProjectPageProps) {
  const [detail, setDetail] = useState<ProjectDetailData | null>(null);
  const [error, setError] = useState<string | undefined>();
  const [notice, setNotice] = useState<string | undefined>();
  const [createOpen, setCreateOpen] = useState(false);
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState<string | undefined>();
  const [refreshingId, setRefreshingId] = useState<number | null>(null);
  const [useOpen, setUseOpen] = useState(false);
  const [useName, setUseName] = useState('');
  const [useBusy, setUseBusy] = useState(false);
  const [renameTarget, setRenameTarget] = useState<FundUse | null>(null);
  const [renameName, setRenameName] = useState('');
  const [acctEdit, setAcctEdit] = useState<ProjectAccount | 'new' | null>(null);
  const [holder, setHolder] = useState('');
  const [acctBank, setAcctBank] = useState('');
  const [acctNo, setAcctNo] = useState('');
  const [openedOn, setOpenedOn] = useState('');
  const [acctUseId, setAcctUseId] = useState('');

  const load = useCallback(async () => {
    try {
      setDetail(await api.getProject(projectId));
      setError(undefined);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  const project: ProjectView | undefined = detail?.project;

  async function doCreate(input: CreateEntityInput) {
    setCreateBusy(true);
    setCreateError(undefined);
    try {
      await api.createTask(projectId, input);
      await load();
      setCreateOpen(false);
      setNotice(`任务「${input.name.trim()}」已创建，把流水 PDF 放进任务目录即可`);
    } catch (e) {
      setCreateError((e as Error).message);
    } finally {
      setCreateBusy(false);
    }
  }

  async function doRemoveTask(t: TaskView) {
    const ok = await confirmDialog(`删除任务「${t.name}」？文件与交易登记一并删除（目录文件不动）。`, {
      title: '删除任务',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.deleteTask(t.id);
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function doRefresh(t: TaskView) {
    setRefreshingId(t.id);
    try {
      const r = await api.refreshTask(t.id);
      setNotice(`重新扫描完成，新增 ${r.added} 份 PDF`);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRefreshingId(null);
    }
  }

  async function addUse() {
    const name = useName.trim();
    if (!name || !project) return;
    setUseBusy(true);
    try {
      await api.createFundUse(project.id, name);
      setUseName('');
      setUseOpen(false);
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setUseBusy(false);
    }
  }

  async function saveRename() {
    const name = renameName.trim();
    if (!name || !project || !renameTarget) return;
    setUseBusy(true);
    try {
      await api.renameFundUse(project.id, renameTarget.id, name);
      setRenameTarget(null);
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setUseBusy(false);
    }
  }

  async function removeUse(u: FundUse) {
    if (!project) return;
    const ok = await confirmDialog(`删除募投项目「${u.name}」？选了它的募资专户会空出来，流水不动。`, {
      title: '删除募投项目',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.deleteFundUse(project.id, u.id);
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  function openAccount(row: ProjectAccount | 'new') {
    setAcctEdit(row);
    setHolder(row === 'new' ? '' : row.holder);
    setAcctBank(row === 'new' ? '' : row.bank);
    setAcctNo(row === 'new' ? '' : row.accountNo);
    setOpenedOn(row === 'new' ? '' : row.openedOn ?? '');
    setAcctUseId(row === 'new' || row.fundUseId == null ? '' : String(row.fundUseId));
  }

  async function saveAccount() {
    if (!project || !acctEdit) return;
    const body = {
      holder: holder.trim(),
      bank: acctBank.trim(),
      accountNo: acctNo.trim(),
      openedOn,
      fundUseId: acctUseId ? Number(acctUseId) : null,
    };
    if (!body.holder || !body.bank || !body.accountNo || !body.openedOn) return;
    setUseBusy(true);
    try {
      if (acctEdit === 'new') await api.createAccount(project.id, body);
      else await api.updateAccount(project.id, acctEdit.id, body);
      setAcctEdit(null);
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setUseBusy(false);
    }
  }

  async function removeAccount(a: ProjectAccount) {
    if (!project) return;
    const ok = await confirmDialog(`删除募资专户「${a.holder}」？流水不动。`, {
      title: '删除募资专户',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.deleteAccount(project.id, a.id);
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div className="page">
      <nav className="breadcrumb">
        <button className="breadcrumb-link" onClick={() => onBackToClient(detail?.client.id ?? 0)}>
          首页
        </button>
        <ChevronRight size={12} className="breadcrumb-sep" />
        <button className="breadcrumb-link" onClick={() => onBackToClient(detail?.client.id ?? 0)}>
          {detail?.client.name ?? '…'}
        </button>
        <ChevronRight size={12} className="breadcrumb-sep" />
        <span className="breadcrumb-current">{project?.name ?? '加载中…'}</span>
      </nav>

      {error ? <div className="flow-error">{error}</div> : null}
      {notice ? <div className="flow-notice">{notice}</div> : null}

      {detail ? (
        <section className="page-section">
          <div className="page-header" style={{ marginBottom: 12 }}>
            <div>
              <h1 style={{ fontSize: 18, marginBottom: 2 }}>募资专户</h1>
            </div>
            <div className="page-header-actions">
              <button className="primary-button" disabled={!project} onClick={() => openAccount('new')}>
                <Plus size={15} /> 新建募资专户
              </button>
            </div>
          </div>
          {detail.accounts.length === 0 ? (
            <div className="flow-empty">
              <h3>还没有募资专户</h3>
              <p>先录入账户主体、开户行、账号和开户时间。各期流水会按这份清单核对是否到齐。</p>
              <div className="flow-empty-actions">
                <button className="primary-button" onClick={() => openAccount('new')}>
                  <Plus size={15} /> 新建募资专户
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className="acct-table">
              <ListRowHeader
                withMenu
                cols={[
                  { label: '账户主体', cls: 'acct-col-holder' },
                  { label: '开户行', cls: 'acct-col-bank' },
                  { label: '账号', cls: 'acct-col-no' },
                  { label: '开户时间', cls: 'acct-col-date' },
                  { label: '募投项目', cls: 'acct-col-use' },
                ]}
              />
              {detail.accounts.map((a) => (
                <ListRow
                  key={a.id}
                  title={a.holder}
                  onClick={() => openAccount(a)}
                  menuItems={[
                    { label: '修改', onClick: () => openAccount(a) },
                    { label: '删除', danger: true, onClick: () => void removeAccount(a) },
                  ]}
                >
                  <span className="acct-col-holder" title={a.holder}>{a.holder}</span>
                  <span className="acct-col-bank" title={a.bank}>{a.bank}</span>
                  <span className="acct-col-no" title={a.accountNo}>{a.accountNo}</span>
                  <span className="acct-col-date">{a.openedOn || '—'}</span>
                  <span className="acct-col-use" title={a.fundUse || undefined}>{a.fundUse || '—'}</span>
                </ListRow>
              ))}
              </div>
            </>
          )}
        </section>
      ) : null}

      {detail ? (
        <section className="page-section">
          <div className="page-header" style={{ marginBottom: 12 }}>
            <div>
              <h1 style={{ fontSize: 18, marginBottom: 2 }}>募投项目</h1>
            </div>
            <div className="page-header-actions">
              <button className="primary-button" disabled={!project} onClick={() => { setUseName(''); setUseOpen(true); }}>
                <Plus size={15} /> 新建募投项目
              </button>
            </div>
          </div>

          {detail.fundUses.length === 0 ? (
            <div className="flow-empty">
              <h3>还没有募投项目</h3>
              <p>建好后，在募资专户里选上对应项目。</p>
              <div className="flow-empty-actions">
                <button className="primary-button" onClick={() => { setUseName(''); setUseOpen(true); }}>
                  <Plus size={15} /> 新建募投项目
                </button>
              </div>
            </div>
          ) : (
            <>
              <ListRowHeader
                withMenu
                cols={[
                  { label: '名称', cls: 'list-row-col-title' },
                  { label: '账户', cls: 'list-row-col-count' },
                ]}
              />
              {detail.fundUses.map((u) => {
                const n = detail.accounts.filter((a) => a.fundUseId === u.id).length;
                return (
                  <ListRow
                    key={u.id}
                    title={u.name}
                    menuItems={[
                      {
                        label: '重命名',
                        onClick: () => {
                          setRenameName(u.name);
                          setRenameTarget(u);
                        },
                      },
                      { label: '删除', danger: true, onClick: () => void removeUse(u) },
                    ]}
                  >
                    <span className="list-row-col-title">{u.name}</span>
                    <span className={`list-row-col-count${n === 0 ? ' empty' : ''}`}>{n}</span>
                  </ListRow>
                );
              })}
            </>
          )}
        </section>
      ) : null}

      <div className="page-header" style={{ marginBottom: 12 }}>
        <div>
          <h1 style={{ fontSize: 18, marginBottom: 2 }}>报告期任务</h1>
          <p>一个报告期/一类分析一个任务；流水 PDF 放任务目录，报告输出到任务目录 flow-output/</p>
        </div>
        <div className="page-header-actions">
          <button className="primary-button" disabled={!project} onClick={() => setCreateOpen(true)}>
            <Plus size={15} /> 新建报告期任务
          </button>
        </div>
      </div>

      {detail && detail.tasks.length === 0 ? (
        <div className="flow-empty">
          <h3>还没有报告期任务</h3>
          <p>
            创建报告期任务（如「2024 年度募资流水分析」），把该报告期的银行流水 PDF 放进任务目录，即可开始解析。
          </p>
          <div className="flow-empty-actions">
            <button className="primary-button" onClick={() => setCreateOpen(true)}>
              <Plus size={15} /> 新建报告期任务
            </button>
          </div>
        </div>
      ) : null}

      {detail ? (
        detail.tasks.length > 0 ? (
          <>
            <ListRowHeader
              withMenu
              cols={[
                { label: '创建日期', cls: 'list-row-col-created' },
                { label: '任务名称', cls: 'list-row-col-title' },
                { label: '文件', cls: 'list-row-col-count' },
                { label: '交易', cls: 'list-row-col-count' },
                { label: '状态', cls: 'list-row-col-status' },
              ]}
            />
            {detail.tasks.map((t) => (
              <ListRow
                key={t.id}
                onClick={() => onOpenTask(t.id)}
                title={t.name}
                menuItems={[
                  {
                    label: '重新扫描',
                    disabled: refreshingId === t.id,
                    onClick: () => void doRefresh(t),
                  },
                  { label: '打开文件夹', onClick: () => void api.openTaskFolder(t.id).catch(() => undefined) },
                  { label: '删除', danger: true, onClick: () => void doRemoveTask(t) },
                ]}
              >
                <span className="list-row-col-created">{formatDate(t.createdAt)}</span>
                <span className="list-row-col-title">
                  {refreshingId === t.id ? <RefreshCw size={12} className="spin" style={{ marginRight: 6 }} /> : null}
                  {t.name}
                </span>
                <span className={`list-row-col-count${t.fileCount === 0 ? ' empty' : ''}`}>{t.fileCount}</span>
                <span className={`list-row-col-count${t.txCount === 0 ? ' empty' : ''}`}>{t.txCount}</span>
                <span className="list-row-col-status">
                  <span className="list-row-chip">
                    {t.dirMissing ? <span className="chip chip-danger">目录丢失</span> : null}
                    {t.fileCount > 0 && t.txCount > 0 ? <span className="chip chip-primary">{t.txCount} 笔</span> : null}
                  </span>
                </span>
              </ListRow>
            ))}
          </>
        ) : null
      ) : null}

      {acctEdit ? (
        <Modal
          title={acctEdit === 'new' ? '新建募资专户' : '修改募资专户'}
          onClose={() => !useBusy && setAcctEdit(null)}
          disableDismiss={useBusy}
          width={440}
        >
          <div className="field">
            <span className="field-label">账户主体</span>
            <SuggestInput
              value={holder}
              autoFocus
              choices={filledChoices((detail?.accounts ?? []).map((a) => a.holder))}
              onChange={setHolder}
            />
          </div>
          <div className="field">
            <span className="field-label">开户行</span>
            <SuggestInput
              value={acctBank}
              choices={filledChoices((detail?.accounts ?? []).map((a) => a.bank))}
              onChange={setAcctBank}
            />
          </div>
          <div className="field">
            <span className="field-label">账号</span>
            <input
              className="input mono"
              value={acctNo}
              onChange={(e) => setAcctNo(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void saveAccount();
              }}
            />
          </div>
          <div className="field">
            <span className="field-label">开户时间</span>
            <input className="input" type="date" value={openedOn} onChange={(e) => setOpenedOn(e.target.value)} />
          </div>
          <div className="field">
            <span className="field-label">募投项目</span>
            <select className="input" value={acctUseId} onChange={(e) => setAcctUseId(e.target.value)}>
              <option value="">不挂</option>
              {(detail?.fundUses ?? []).map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </select>
          </div>
          <div className="modal-actions">
            <button className="secondary-button" disabled={useBusy} onClick={() => setAcctEdit(null)}>
              取消
            </button>
            <button
              className="primary-button"
              disabled={useBusy || !holder.trim() || !acctBank.trim() || !acctNo.trim() || !openedOn}
              onClick={() => void saveAccount()}
            >
              {acctEdit === 'new' ? '创建' : '保存'}
            </button>
          </div>
        </Modal>
      ) : null}

      {useOpen ? (
        <Modal title="新建募投项目" onClose={() => !useBusy && setUseOpen(false)} disableDismiss={useBusy} width={420}>
          <div className="field">
            <span className="field-label">名称</span>
            <input
              className="input"
              value={useName}
              placeholder="例如 年产10万吨高端铝板"
              autoFocus
              onChange={(e) => setUseName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void addUse();
              }}
            />
          </div>
          <div className="modal-actions">
            <button className="secondary-button" disabled={useBusy} onClick={() => setUseOpen(false)}>
              取消
            </button>
            <button className="primary-button" disabled={useBusy || !useName.trim()} onClick={() => void addUse()}>
              创建
            </button>
          </div>
        </Modal>
      ) : null}

      {renameTarget ? (
        <Modal title="重命名" onClose={() => !useBusy && setRenameTarget(null)} disableDismiss={useBusy} width={420}>
          <div className="field">
            <span className="field-label">名称</span>
            <input
              className="input"
              value={renameName}
              autoFocus
              onChange={(e) => setRenameName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void saveRename();
              }}
            />
          </div>
          <div className="modal-actions">
            <button className="secondary-button" disabled={useBusy} onClick={() => setRenameTarget(null)}>
              取消
            </button>
            <button
              className="primary-button"
              disabled={useBusy || !renameName.trim() || renameName.trim() === renameTarget.name}
              onClick={() => void saveRename()}
            >
              保存
            </button>
          </div>
        </Modal>
      ) : null}

      {createOpen && project ? (
        <CreateDialog
          title="新建报告期任务"
          lead="任务目录创建在项目目录内；流水 PDF 放任务目录，解析报告输出到任务目录 flow-output/。"
          namePlaceholder="例如 2024 年度募资流水分析 / 2025H1 核查"
          resolveParent={async () => project.folderPath}
          busy={createBusy}
          error={createError}
          onClose={() => setCreateOpen(false)}
          onCreate={(input) => doCreate(input)}
        />
      ) : null}
    </div>
  );
}

