import { Plus } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { ClientView, CreateEntityInput } from '@flow/shared';
import { api } from '../api';
import { CreateDialog } from '../components/CreateDialog';
import { ListRow, ListRowHeader } from '../components/ListRow';
import { confirmDialog } from '../lib/confirm';
import { formatDate } from '../lib/format';

type HomeProps = {
  onOpenClient: (id: number) => void;
};

export function HomePage({ onOpenClient }: HomeProps) {
  const [clients, setClients] = useState<ClientView[] | null>(null);
  const [error, setError] = useState<string | undefined>();
  const [createOpen, setCreateOpen] = useState(false);
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState<string | undefined>();

  const load = useCallback(async () => {
    try {
      setClients(await api.listClients());
      setError(undefined);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function doCreate(input: CreateEntityInput) {
    setCreateBusy(true);
    setCreateError(undefined);
    try {
      const c = await api.createClient(input);
      await load();
      setCreateOpen(false);
      onOpenClient(c.id);
    } catch (e) {
      setCreateError((e as Error).message);
    } finally {
      setCreateBusy(false);
    }
  }

  async function doRemove(c: ClientView) {
    const ok = await confirmDialog(`删除客户「${c.name}」？其下项目与任务的登记一并删除（目录文件不动）。`, {
      title: '删除客户',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.deleteClient(c.id);
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function doOpenFolder(c: ClientView) {
    try {
      await api.openClientFolder(c.id);
    } catch {
      /* 忽略：explorer 拉起失败不致命 */
    }
  }

  const totalProjects = clients?.reduce((s, c) => s + c.projectCount, 0) ?? 0;

  return (
    <div className="page">
      <section className="page-section">
      <div className="page-header">
        <div>
          <h1>客户</h1>
          <p>
            {clients
              ? `共 ${clients.length} 个客户 · ${totalProjects} 个融资项目`
              : '客户 = 被核查的上市公司；其下有融资项目与报告期任务'}
          </p>
        </div>
        <div className="page-header-actions">
          <button className="primary-button" onClick={() => setCreateOpen(true)}>
            <Plus size={15} /> 新建客户
          </button>
        </div>
      </div>

      {error ? <div className="flow-error">{error}</div> : null}

      {!clients ? null : clients.length === 0 ? (
        <div className="flow-empty">
          <h3>还没有客户</h3>
          <div className="flow-empty-actions">
            <button className="primary-button" onClick={() => setCreateOpen(true)}>
              <Plus size={15} /> 新建客户
            </button>
          </div>
        </div>
      ) : (
        <>
          <ListRowHeader
            withMenu
            cols={[
              { label: '创建日期', cls: 'list-row-col-created' },
              { label: '客户名称', cls: 'list-row-col-title' },
              { label: '项目', cls: 'list-row-col-count' },
              { label: '任务', cls: 'list-row-col-count' },
              { label: '状态', cls: 'list-row-col-status' },
            ]}
          />
          {clients.map((c) => (
            <ListRow
              key={c.id}
              onClick={() => onOpenClient(c.id)}
              title={c.name}
              menuItems={[
                { label: '打开文件夹', onClick: () => void doOpenFolder(c) },
                { label: '删除', danger: true, onClick: () => void doRemove(c) },
              ]}
            >
              <span className="list-row-col-created">{formatDate(c.createdAt)}</span>
              <span className="list-row-col-title">{c.name}</span>
              <span className={`list-row-col-count${c.projectCount === 0 ? ' empty' : ''}`}>{c.projectCount}</span>
              <span className={`list-row-col-count${c.taskCount === 0 ? ' empty' : ''}`}>{c.taskCount}</span>
              <span className="list-row-col-status">
                <span className="list-row-chip">
                  {c.dirMissing ? <span className="chip chip-danger">目录丢失</span> : null}
                  {c.status === 'done' ? <span className="chip chip-success">已完成</span> : null}
                  {c.status === 'archived' ? <span className="chip chip-muted">已归档</span> : null}
                </span>
              </span>
            </ListRow>
          ))}
        </>
      )}
      </section>

      {createOpen ? (
        <CreateDialog
          title="新建客户"
          lead="客户用于归组融资项目并绑定本地目录。创建时建立客户目录并写入标记文件。"
          namePlaceholder="例如 xx股份有限公司"
          resolveParent={async () => (await api.fsRoot()).root}
          busy={createBusy}
          error={createError}
          onClose={() => setCreateOpen(false)}
          onCreate={(input) => doCreate(input)}
        />
      ) : null}
    </div>
  );
}
