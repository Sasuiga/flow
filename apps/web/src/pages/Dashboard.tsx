import { useCallback, useEffect, useState } from 'react';
import {
  Button,
  Card,
  Empty,
  Form,
  Input,
  Modal,
  Popconfirm,
  Space,
  Table,
  Tag,
  message,
} from 'antd';
import { PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import { BankFile } from '@flow/shared';
import { api, ProjectView } from '../api';

const STATUS_TAG: Record<string, { color: string; label: string }> = {
  scanned: { color: 'default', label: '待解析' },
  parsing: { color: 'processing', label: '解析中' },
  done: { color: 'success', label: '已完成' },
  error: { color: 'error', label: '错误' },
  needs_review: { color: 'warning', label: '待复核' },
};

export default function Dashboard() {
  const [projects, setProjects] = useState<ProjectView[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [files, setFiles] = useState<BankFile[]>([]);
  const [modalOpen, setModalOpen] = useState(false);
  const [form] = Form.useForm();
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const list = await api.listProjects();
    setProjects(list);
    return list;
  }, []);

  useEffect(() => {
    load().catch((e) => message.error((e as Error).message));
  }, [load]);

  const loadFiles = useCallback(async (id: number) => {
    try {
      setFiles(await api.listFiles(id));
    } catch (e) {
      message.error((e as Error).message);
    }
  }, []);

  useEffect(() => {
    if (selected !== null) loadFiles(selected);
    else setFiles([]);
  }, [selected, loadFiles]);

  const createProject = async () => {
    const v = await form.validateFields();
    setBusy(true);
    try {
      const p = await api.createProject(v.name, v.folderPath);
      message.success(`项目已创建，登记到 ${p.added} 份 PDF`);
      setModalOpen(false);
      form.resetFields();
      await load();
      setSelected(p.id);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const refresh = async (id: number) => {
    try {
      const r = await api.refreshProject(id);
      message.success(`重新扫描完成，新增 ${r.added} 份 PDF`);
      await load();
      if (selected === id) loadFiles(id);
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  const remove = async (id: number) => {
    try {
      await api.deleteProject(id);
      if (selected === id) setSelected(null);
      await load();
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
        <h2 style={{ margin: 0 }}>项目</h2>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setModalOpen(true)}>
          新建项目
        </Button>
      </div>

      {projects.length === 0 ? (
        <Card>
          <Empty description="还没有项目。新建项目并选择存放银行流水 PDF 的文件夹，放进去的文件会自动登记" />
        </Card>
      ) : (
        <Table
          rowKey="id"
          size="middle"
          pagination={false}
          dataSource={projects}
          onRow={(p) => ({
            onClick: () => setSelected(p.id === selected ? null : p.id),
            style: { cursor: 'pointer', background: p.id === selected ? '#f0f7ff' : undefined },
          })}
          columns={[
            { title: '项目', dataIndex: 'name' },
            { title: '文件夹', dataIndex: 'folderPath', ellipsis: true },
            { title: '文件数', dataIndex: 'fileCount', width: 80 },
            { title: '交易数', dataIndex: 'txCount', width: 80 },
            { title: '创建时间', dataIndex: 'createdAt', width: 180, render: (v: string) => v?.slice(0, 16) },
            {
              title: '操作',
              width: 180,
              render: (_: unknown, p: ProjectView) => (
                <Space onClick={(e) => e.stopPropagation()}>
                  <Button size="small" icon={<ReloadOutlined />} onClick={() => refresh(p.id)}>
                    重新扫描
                  </Button>
                  <Popconfirm title="删除项目？（文件表与交易记录一并删除）" onConfirm={() => remove(p.id)}>
                    <Button size="small" danger>
                      删除
                    </Button>
                  </Popconfirm>
                </Space>
              ),
            },
          ]}
        ></Table>
      )}

      {selected !== null && (
        <Card title="项目文件（流水 PDF）" size="small">
          {files.length === 0 ? (
            <Empty description="文件夹里还没有 PDF（或路径无效）" />
          ) : (
            <Table
              rowKey="id"
              size="small"
              pagination={{ pageSize: 10 }}
              dataSource={files}
              columns={[
                { title: '文件', dataIndex: 'relPath', ellipsis: true },
                {
                  title: '状态',
                  dataIndex: 'status',
                  width: 100,
                  render: (s: string) => {
                    const t = STATUS_TAG[s] ?? { color: 'default', label: s };
                    return <Tag color={t.color}>{t.label}</Tag>;
                  },
                },
                { title: '银行', dataIndex: 'bank', width: 120, render: (v) => v ?? '—' },
                { title: '账户', dataIndex: 'accountNo', width: 200, ellipsis: true, render: (v) => v ?? '—' },
                { title: '交易数', dataIndex: 'txCount', width: 80 },
                { title: '更新时间', dataIndex: 'updatedAt', width: 160, render: (v: string) => v?.slice(0, 16) },
              ]}
            />
          )}
        </Card>
      )}

      <Modal
        title="新建项目"
        open={modalOpen}
        onOk={createProject}
        confirmLoading={busy}
        onCancel={() => setModalOpen(false)}
        okText="创建"
      >
        <Form form={form} layout="vertical">
          <Form.Item label="项目名" name="name" rules={[{ required: true, message: '请输入项目名' }]}>
            <Input placeholder="例如：某某股份 2025 年度核查" />
          </Form.Item>
          <Form.Item
            label="流水文件夹（本机路径）"
            name="folderPath"
            rules={[{ required: true, message: '请输入文件夹路径' }]}
            extra="把银行流水 PDF 放进该文件夹即可自动登记；之后放入的新文件点「重新扫描」"
          >
            <Input placeholder="例如 C:\flow-data\某某股份" />
          </Form.Item>
        </Form>
      </Modal>
    </Space>
  );
}
