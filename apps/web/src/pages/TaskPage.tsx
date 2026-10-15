import { Check, ChevronRight, Loader2, Minus, Play, RefreshCw, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { BankFile, FileStatus, normAccountNo, ParseStep, ProjectAccount } from '@flow/shared';
import { api, TaskDetail } from '../api';
import { ListRow, ListRowHeader } from '../components/ListRow';
import { confirmDialog } from '../lib/confirm';
import { formatDateTime } from '../lib/format';

const STATUS_CHIP: Record<FileStatus, { cls: string; label: string }> = {
  scanned: { cls: 'chip-muted', label: '待解析' },
  parsing: { cls: 'chip-primary', label: '解析中' },
  done: { cls: 'chip-success', label: '已完成' },
  error: { cls: 'chip-danger', label: '错误' },
  needs_review: { cls: 'chip-warning', label: '待复核' },
};

type TaskPageProps = {
  taskId: number;
  onBackToProject: (projectId: number) => void;
  /** 点一个文件：按该文件的银行、账户进入交易页，筛选仍可改 */
  onBrowseFile: (file: BankFile) => void;
  /** 任务有增删 → 顶栏最近任务列表刷新 */
  onChangedTasks?: () => void;
};

export function TaskPage({ taskId, onBackToProject, onBrowseFile, onChangedTasks }: TaskPageProps) {
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [error, setError] = useState<string | undefined>();
  const [notice, setNotice] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    try {
      setDetail(await api.getTask(taskId));
      setError(undefined);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [taskId]);

  useEffect(() => {
    void load();
  }, [load]);

  const task = detail?.task;
  const anyParsing = detail?.files.some((f) => f.status === 'parsing') ?? false;

  // M2：解析中每 4s 轮询一次（chokidar 自动解析 + 队列推进）
  useEffect(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    if (anyParsing) {
      timerRef.current = setInterval(() => void load(), 2000);
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [anyParsing, load]);

  async function doRefresh() {
    setBusy(true);
    setNotice(undefined);
    try {
      const r = await api.refreshTask(taskId);
      setNotice(`重新扫描完成，新增 ${r.added} 份 PDF（新文件自动入解析队列）`);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function doParseAll() {
    const doneCount = detail?.files.filter((f) => f.txCount > 0 && f.status !== 'parsing').length ?? 0;
    if (doneCount > 0) {
      const ok = await confirmDialog(
        `其中 ${doneCount} 份已经解析过。重新解析会按当前规则重抽，原有交易（含人工修改）会被替换。`,
        { title: '重新解析已完成的文件', confirmLabel: '重新解析' },
      );
      if (!ok) return;
    }
    setBusy(true);
    setNotice(undefined);
    try {
      const r = await api.parseTask(taskId);
      setNotice(
        r.queued > 0
          ? `已加入解析队列 ${r.queued} 份${r.added ? `（新扫描 ${r.added} 份）` : ''}，完成后交易会按新规则替换`
          : '没有可解析的文件（可能都在解析中）',
      );
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function doParse(f: BankFile) {
    if (f.txCount > 0) {
      const ok = await confirmDialog(`重新解析「${f.relPath}」？原有 ${f.txCount} 笔交易（含人工修改）会被替换。`, {
        title: '重新解析',
        confirmLabel: '重新解析',
      });
      if (!ok) return;
    }
    setNotice(undefined);
    try {
      const r = await api.parseFile(f.id);
      setNotice(r.queued ? `「${f.relPath}」已加入解析队列，完成后会替换原交易` : '该文件正在解析中');
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function doRemove(f: BankFile) {
    const ok = await confirmDialog(
      `删除「${f.relPath}」的登记？${f.txCount > 0 ? `其下 ${f.txCount} 笔交易一并删除` : '（尚未解析，无交易）'}磁盘 PDF 不动，重新扫描可恢复。`,
      { title: '删除文件登记', danger: true },
    );
    if (!ok) return;
    try {
      await api.deleteFile(f.id);
      setNotice(`「${f.relPath}」登记已删除`);
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div className="page">
      <nav className="breadcrumb">
        <button className="breadcrumb-link" onClick={() => onBackToProject(detail?.project.id ?? 0)}>
          首页
        </button>
        <ChevronRight size={12} className="breadcrumb-sep" />
        <button className="breadcrumb-link" onClick={() => onBackToProject(detail?.project.id ?? 0)}>
          {detail?.client.name ?? '…'}
        </button>
        <ChevronRight size={12} className="breadcrumb-sep" />
        <button className="breadcrumb-link" onClick={() => onBackToProject(detail?.project.id ?? 0)}>
          {detail?.project.name ?? '…'}
        </button>
        <ChevronRight size={12} className="breadcrumb-sep" />
        <span className="breadcrumb-current">{task?.name ?? '加载中…'}</span>
      </nav>

      {error ? <div className="flow-error">{error}</div> : null}
      {notice ? <div className="flow-notice">{notice}</div> : null}

      {task ? (
        <div className="entity-bar">
          <div className="entity-bar-main">
            <div className="entity-bar-title">
              {task.name}
              {task.dirMissing ? <span className="chip chip-danger">目录丢失</span> : null}
              <span className="chip chip-muted">
                {task.fileCount} 文件 · {task.txCount} 笔交易
              </span>
              {anyParsing ? (
                <span className="chip chip-primary">
                  <RefreshCw size={11} className="spin" style={{ marginRight: 4 }} />
                  解析中…
                </span>
              ) : null}
            </div>
            <div className="entity-bar-path">
              <span className="path-chip" title={task.folderPath}>
                {task.folderPath}
              </span>
            </div>
          </div>
          <div className="page-header-actions" style={{ marginTop: 4, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            <button className="secondary-button" disabled={task.dirMissing || busy} onClick={() => void doParseAll()}>
              <Play size={13} /> 全部解析
            </button>
            <button className="secondary-button" disabled={task.dirMissing || busy} onClick={() => void doRefresh()}>
              <RefreshCw size={13} /> 重新扫描
            </button>
            <button
              className="secondary-button"
              disabled={task.dirMissing}
              onClick={() => void api.openTaskFolder(task.id).catch(() => undefined)}
            >
              打开文件夹
            </button>
            <button
              className="secondary-button"
              onClick={async () => {
                const ok = await confirmDialog(`删除任务「${task.name}」？文件与交易登记一并删除（目录文件不动）。`, {
                  title: '删除任务',
                  danger: true,
                });
                if (!ok) return;
                await api.deleteTask(task.id).catch((e) => setError((e as Error).message));
                onChangedTasks?.();
                if (ok) onBackToProject(detail!.project.id);
              }}
            >
              <Trash2 size={13} /> 删除任务
            </button>
          </div>
        </div>
      ) : null}

      {detail && (detail.accounts?.length ?? 0) > 0 ? (
        <AccountCoverage accounts={detail.accounts} files={detail.files} />
      ) : null}

      <div className="page-header" style={{ marginBottom: 12 }}>
        <div>
          <h1 style={{ fontSize: 18, marginBottom: 2 }}>流水文件</h1>
          <p>任务目录内的银行流水 PDF（递归扫描；.flow 与 flow-output 除外）——放入即自动登记并解析</p>
        </div>
      </div>

      {detail ? (
        detail.files.length === 0 ? (
          <div className="flow-empty">
            <h3>{task?.dirMissing ? '目录丢失' : '还没有登记 PDF'}</h3>
            <p>
              {task?.dirMissing
                ? '任务目录不存在（可能被移动/删除），恢复目录后点「重新扫描」。'
                : '把银行流水 PDF 放进任务目录，会自动登记并解析；点「重新扫描」可手动补扫。'}
            </p>
            <div className="flow-empty-actions">
              <button className="primary-button" disabled={busy} onClick={() => void doRefresh()}>
                <RefreshCw size={15} /> 重新扫描
              </button>
            </div>
          </div>
        ) : (
          <>
            <ListRowHeader
              withMenu
              cols={[
                { label: '文件', cls: 'list-row-col-title' },
                { label: '状态', cls: 'file-col-status' },
                { label: '交易数', cls: 'list-row-col-count' },
                { label: '更新时间', cls: 'list-row-col-updated' },
              ]}
            />
            {detail.files.map((f) => {
              const chip = STATUS_CHIP[f.status] ?? { cls: 'chip-muted', label: f.status };
              const accounts = detail.accounts ?? [];
              const foreign =
                accounts.length > 0 &&
                !!f.accountNo &&
                !accounts.some((a) => normAccountNo(a.accountNo) === normAccountNo(f.accountNo));
              return (
                <div key={f.id}>
                  <ListRow
                    active={f.status === 'parsing'}
                    onClick={() => onBrowseFile(f)}
                    title={f.relPath}
                    menuItems={[
                      { label: '查看交易', onClick: () => onBrowseFile(f) },
                      f.status === 'done' || f.status === 'needs_review'
                        ? { label: '重新解析', onClick: () => void doParse(f) }
                        : { label: '开始解析', disabled: f.status === 'parsing', onClick: () => void doParse(f) },
                      { label: '删除登记', danger: true, onClick: () => void doRemove(f) },
                    ]}
                  >
                    <div className="file-row-cols">
                      <span className="list-row-col-title" title={f.relPath}>
                        <span className="file-name">{f.relPath}</span>
                        {foreign ? <span className="chip chip-warning">不是募资专户</span> : null}
                      </span>
                      <span className="file-col-status">
                        <span className={`chip ${chip.cls}`}>
                          {f.status === 'parsing' ? <RefreshCw size={11} className="spin" style={{ marginRight: 4 }} /> : null}
                          {chip.label}
                        </span>
                      </span>
                      <span className={`list-row-col-count${f.txCount === 0 ? ' empty' : ''}`}>{f.txCount}</span>
                      <span className="list-row-col-updated">{formatDateTime(f.updatedAt)}</span>
                    </div>
                  </ListRow>
                  {f.status === 'error' && f.error ? (
                    <div className="file-error" title={f.error}>
                      {f.error}
                    </div>
                  ) : null}
                </div>
              );
            })}
            <ParseBoards files={detail.files} />
          </>
        )
      ) : null}
    </div>
  );
}

function AccountCoverage({ accounts, files }: { accounts: ProjectAccount[]; files: BankFile[] }) {
  const ready = (a: ProjectAccount) =>
    files.some((f) => f.accountNo && normAccountNo(f.accountNo) === normAccountNo(a.accountNo));
  const missing = accounts.filter((a) => !ready(a)).length;
  return (
    <section className="page-section">
      <div className="page-header" style={{ marginBottom: 12 }}>
        <div>
          <h1 style={{ fontSize: 18, marginBottom: 2 }}>募资专户</h1>
        </div>
        <div className="page-header-actions">
          {missing === 0 ? <span className="chip chip-success">已齐</span> : <span className="chip chip-warning">缺 {missing} 个</span>}
        </div>
      </div>
      <ListRowHeader
        cols={[
          { label: '账户主体', cls: 'list-row-col-title' },
          { label: '开户行', cls: 'list-row-col-meta' },
          { label: '账号', cls: 'list-row-col-account' },
          { label: '流水', cls: 'list-row-col-status' },
        ]}
      />
      {accounts.map((a) => {
        const ok = ready(a);
        return (
          <ListRow key={a.id} title={a.holder}>
            <span className="list-row-col-title">{a.holder}</span>
            <span className="list-row-col-meta">{a.bank}</span>
            <span className="list-row-col-account">{a.accountNo}</span>
            <span className="list-row-col-status">
              <span className={`chip ${ok ? 'chip-success' : 'chip-warning'}`}>{ok ? '已提供' : '未提供'}</span>
            </span>
          </ListRow>
        );
      })}
    </section>
  );
}

function ParseBoards({ files }: { files: BankFile[] }) {
  const shown = files.filter((f) => f.status === 'parsing' || (f.status === 'error' && (f.progress?.length ?? 0) > 0));
  if (shown.length === 0) return null;
  return (
    <div className="parse-board">
      {shown.map((f) => {
        const steps: ParseStep[] =
          f.progress && f.progress.length > 0
            ? f.progress
            : [{ id: 'read', label: '读取 PDF', state: 'run', detail: '正在开始' }];
        const current = steps.find((s) => s.state === 'run' || s.state === 'fail');
        return (
          <section key={f.id} className="parse-card">
            <header className="parse-card-head">
              <span className="parse-card-file">{f.relPath}</span>
              <span className="parse-card-now">{current ? `${current.label}${current.detail ? ` · ${current.detail}` : ''}` : '处理中'}</span>
            </header>
            <ol className="parse-steps">
              {steps.map((step) => (
                <li key={step.id} className={`parse-step ${step.state}`}>
                  <span className="parse-mark">{stepMark(step.state)}</span>
                  <span className="parse-label">{step.label}</span>
                  {step.detail ? <span className="parse-detail">{step.detail}</span> : null}
                </li>
              ))}
            </ol>
          </section>
        );
      })}
    </div>
  );
}

function stepMark(state: ParseStep['state']) {
  if (state === 'run') return <Loader2 size={14} className="spin" />;
  if (state === 'done') return <Check size={14} />;
  if (state === 'fail') return <X size={14} />;
  if (state === 'skip') return <Minus size={14} />;
  return <span className="parse-dot" />;
}
