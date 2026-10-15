import { ChevronRight, Plus, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { CreateEntityInput, ProjectView, TaskView } from '@flow/shared';
import { api, ProjectDetail as ProjectDetailData } from '../api';
import { CreateDialog } from '../components/CreateDialog';
import { ListRow, ListRowHeader } from '../components/ListRow';
import { confirmDialog } from '../lib/confirm';
import { formatDate } from '../lib/format';

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
