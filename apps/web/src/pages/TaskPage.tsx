import { ChevronRight, Play, RefreshCw, ScrollText, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { BankFile, FileStatus } from '@flow/shared';
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
  /** 任务级：查看该任务全部交易 */
  onBrowseTx: (taskId: number) => void;
  /** 文件级下钻：只看这个文件的交易 */
  onBrowseFileTx: (taskId: number, fileId: number) => void;
  /** 任务有增删 → 顶栏最近任务列表刷新 */
  onChangedTasks?: () => void;
};

export function TaskPage({ taskId, onBackToProject, onBrowseTx, onBrowseFileTx, onChangedTasks }: TaskPageProps) {
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
      timerRef.current = setInterval(() => void load(), 4000);
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
    setBusy(true);
    setNotice(undefined);
    try {
      const r = await api.parseTask(taskId);
      setNotice(`已加入解析队列：新增扫描 ${r.added} 份，待解析 ${r.queued} 份（LLM 并发见设置页）`);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function doParse(f: BankFile) {
    setNotice(undefined);
    try {
      const r = await api.parseFile(f.id);
      setNotice(r.queued ? `「${f.relPath}」已加入解析队列` : '该文件正在解析中');
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
            <button className="primary-button" onClick={() => onBrowseTx(task.id)}>
              <ScrollText size={14} /> 查看交易
            </button>
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
              return (
                <div key={f.id}>
                  <ListRow
                    active={f.status === 'parsing'}
                    onClick={() => onBrowseFileTx(taskId, f.id)}
                    title={f.relPath}
                    menuItems={[
                      { label: '查看交易', onClick: () => onBrowseFileTx(taskId, f.id) },
                      f.status === 'done' || f.status === 'needs_review'
                        ? { label: '重新解析', onClick: () => void doParse(f) }
                        : { label: '开始解析', disabled: f.status === 'parsing', onClick: () => void doParse(f) },
                      { label: '删除登记', danger: true, onClick: () => void doRemove(f) },
                    ]}
                  >
                    <div className="file-row-cols">
                      <span className="list-row-col-title" title={f.relPath}>
                        {f.relPath}
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
          </>
        )
      ) : null}
    </div>
  );
}
