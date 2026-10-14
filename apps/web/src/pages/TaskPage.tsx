import { ChevronRight, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
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
};

export function TaskPage({ taskId, onBackToProject }: TaskPageProps) {
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [error, setError] = useState<string | undefined>();
  const [notice, setNotice] = useState<string | undefined>();
  const [refreshing, setRefreshing] = useState(false);

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

  async function doRefresh() {
    setRefreshing(true);
    setNotice(undefined);
    try {
      const r = await api.refreshTask(taskId);
      setNotice(`重新扫描完成，新增 ${r.added} 份 PDF`);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRefreshing(false);
    }
  }

  async function doRemove(f: BankFile) {
    // M1.5 只做文件登记；删除文件登记等 M2 解析后提供
    void f;
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
            </div>
            <div className="entity-bar-path">
              <span className="path-chip" title={task.folderPath}>
                {task.folderPath}
              </span>
            </div>
          </div>
          <div className="page-header-actions" style={{ marginTop: 4 }}>
            <button
              className="secondary-button"
              disabled={task.dirMissing || refreshing}
              onClick={() => void doRefresh()}
            >
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
                if (ok) onBackToProject(detail!.project.id);
              }}
            >
              删除任务
            </button>
          </div>
        </div>
      ) : null}

      <div className="page-header" style={{ marginBottom: 12 }}>
        <div>
          <h1 style={{ fontSize: 18, marginBottom: 2 }}>流水文件</h1>
          <p>任务目录内的银行流水 PDF（递归扫描，自动登记新文件；.flow 与 flow-output 除外）</p>
        </div>
      </div>

      {detail ? (
        detail.files.length === 0 ? (
          <div className="flow-empty">
            <h3>{task?.dirMissing ? '目录丢失' : '还没有登记 PDF'}</h3>
            <p>
              {task?.dirMissing
                ? '任务目录不存在（可能被移动/删除），恢复目录后点「重新扫描」。'
                : '把银行流水 PDF 放进任务目录，点「重新扫描」（或创建时已自动登记）。'}
            </p>
            <div className="flow-empty-actions">
              <button className="primary-button" disabled={refreshing} onClick={() => void doRefresh()}>
                <RefreshCw size={15} /> 重新扫描
              </button>
            </div>
          </div>
        ) : (
          <>
            <ListRowHeader
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
                <ListRow key={f.id}>
                  <div className="file-row-cols">
                    <span className="list-row-col-title" title={f.relPath}>
                      {f.relPath}
                    </span>
                    <span className="file-col-status">
                      <span className={`chip ${chip.cls}`}>{chip.label}</span>
                    </span>
                    <span className={`list-row-col-count${f.txCount === 0 ? ' empty' : ''}`}>{f.txCount}</span>
                    <span className="list-row-col-updated">{formatDateTime(f.updatedAt)}</span>
                  </div>
                </ListRow>
              );
            })}
          </>
        )
      ) : null}
    </div>
  );
}
