import { ChevronRight, Plus } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { ClientView, CreateEntityInput, ProjectView } from '@flow/shared';
import { api, ClientDetail } from '../api';
import { CreateDialog } from '../components/CreateDialog';
import { ListRow, ListRowHeader } from '../components/ListRow';
import { confirmDialog } from '../lib/confirm';
import { formatDate } from '../lib/format';

type ClientPageProps = {
  clientId: number;
  onBack: () => void;
  onOpenProject: (id: number) => void;
};

export function ClientPage({ clientId, onBack, onOpenProject }: ClientPageProps) {
  const [detail, setDetail] = useState<ClientDetail | null>(null);
  const [error, setError] = useState<string | undefined>();
  const [createOpen, setCreateOpen] = useState(false);
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState<string | undefined>();

  const load = useCallback(async () => {
    try {
      setDetail(await api.getClient(clientId));
      setError(undefined);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [clientId]);

  useEffect(() => {
    void load();
  }, [load]);

  const client: ClientView | undefined = detail?.client;

  async function doCreate(input: CreateEntityInput) {
    setCreateBusy(true);
    setCreateError(undefined);
    try {
      await api.createProject(clientId, input);
      await load();
      setCreateOpen(false);
    } catch (e) {
      setCreateError((e as Error).message);
    } finally {
      setCreateBusy(false);
    }
  }

  async function doRemoveProject(p: ProjectView) {
    const ok = await confirmDialog(`删除融资项目「${p.name}」？其下报告期任务的登记一并删除（目录文件不动）。`, {
      title: '删除项目',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.deleteProject(p.id);
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div className="page">
      <nav className="breadcrumb">
        <button className="breadcrumb-link" onClick={onBack}>
          首页
        </button>
        <ChevronRight size={12} className="breadcrumb-sep" />
        <span className="breadcrumb-current">{client?.name ?? '加载中…'}</span>
      </nav>

      {error ? <div className="flow-error">{error}</div> : null}

      <section className="page-section">
      <div className="page-header" style={{ marginBottom: 12 }}>
        <div>
          <h1 style={{ fontSize: 18, marginBottom: 2 }}>融资项目</h1>
        </div>
        <div className="page-header-actions">
          <button className="primary-button" disabled={!client} onClick={() => setCreateOpen(true)}>
            <Plus size={15} /> 新建融资项目
          </button>
        </div>
      </div>

      {detail && detail.projects.length === 0 ? (
        <div className="flow-empty">
          <h3>还没有融资项目</h3>
          <p>为「{client?.name}」创建第一个融资项目（如 IPO），报告期任务将建在项目下。</p>
          <div className="flow-empty-actions">
            <button className="primary-button" onClick={() => setCreateOpen(true)}>
              <Plus size={15} /> 新建融资项目
            </button>
          </div>
        </div>
      ) : null}

      {detail ? (
        detail.projects.length > 0 ? (
          <>
            <ListRowHeader
              withMenu
              cols={[
                { label: '创建日期', cls: 'list-row-col-created' },
                { label: '项目名称', cls: 'list-row-col-title' },
                { label: '任务', cls: 'list-row-col-count' },
                { label: '文件', cls: 'list-row-col-count' },
                { label: '状态', cls: 'list-row-col-status' },
              ]}
            />
            {detail.projects.map((p) => (
              <ListRow
                key={p.id}
                onClick={() => onOpenProject(p.id)}
                title={p.name}
                menuItems={[
                  { label: '打开文件夹', onClick: () => void api.openProjectFolder(p.id).catch(() => undefined) },
                  { label: '删除', danger: true, onClick: () => void doRemoveProject(p) },
                ]}
              >
                <span className="list-row-col-created">{formatDate(p.createdAt)}</span>
                <span className="list-row-col-title">{p.name}</span>
                <span className={`list-row-col-count${p.taskCount === 0 ? ' empty' : ''}`}>{p.taskCount}</span>
                <span className={`list-row-col-count${p.fileCount === 0 ? ' empty' : ''}`}>{p.fileCount}</span>
                <span className="list-row-col-status">
                  <span className="list-row-chip">
                    {p.dirMissing ? <span className="chip chip-danger">目录丢失</span> : null}
                    {p.status === 'archived' ? <span className="chip chip-muted">已归档</span> : null}
                  </span>
                </span>
              </ListRow>
            ))}
          </>
        ) : null
      ) : null}
      </section>

      {createOpen && client ? (
        <CreateDialog
          title="新建融资项目"
          lead="融资项目属客户，拥有独立项目目录；报告期任务将创建在项目目录内。"
          namePlaceholder="例如 IPO / 2026 年可转债 / 再融资"
          resolveParent={async () => client.folderPath}
          busy={createBusy}
          error={createError}
          onClose={() => setCreateOpen(false)}
          onCreate={(input) => doCreate(input)}
        />
      ) : null}
    </div>
  );
}
