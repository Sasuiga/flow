import { useEffect, useRef, useState } from 'react';
import {
  Alert,
  AutoComplete,
  Button,
  Card,
  Checkbox,
  Form,
  Input,
  InputNumber,
  Space,
  Spin,
  Tabs,
  Typography,
  message,
} from 'antd';
import {
  ApiOutlined,
  CloudOutlined,
  EyeInvisibleOutlined,
  EyeOutlined,
  PlusOutlined,
  ReloadOutlined,
  SaveOutlined,
  ScanOutlined,
  TagsOutlined,
  DeleteOutlined,
} from '@ant-design/icons';
import { CATEGORY_DEFS, LlmProfile, Settings as FlowSettings } from '@flow/shared';
import { api, LlmModelsResult } from '../api';

/** 内联状态条：测试结果直接显示在按钮下方，绿色=成功 / 红色=失败 */
function StatusLine({ status }: { status: { loading?: boolean; ok?: boolean; detail?: string } | null }) {
  if (status?.loading)
    return (
      <Space size={8} style={{ marginTop: 12 }}>
        <Spin size="small" />
        <Typography.Text type="secondary">测试中…</Typography.Text>
      </Space>
    );
  if (!status || status.detail === undefined) return null;
  if (status.ok)
    return (
      <Alert
        style={{ marginTop: 12 }}
        type="success"
        showIcon
        message="连接成功"
        description={status.detail ? <span style={{ whiteSpace: 'pre-line' }}>{status.detail}</span> : undefined}
      />
    );
  return (
    <Alert
      style={{ marginTop: 12 }}
      type="error"
      showIcon
      message="连接失败"
      description={status.detail}
    />
  );
}

/** 带 显示/隐藏 切换的请求头输入（仿 Avalon 的 API Key 交互） */
function HeaderInput({
  value,
  onChange,
  placeholder,
}: {
  value?: string;
  onChange?: (v: string) => void;
  placeholder?: string;
}) {
  const [show, setShow] = useState(false);
  return (
    <Input.Group compact style={{ display: 'flex' }}>
      <Input
        style={{ flex: 1 }}
        type={show ? 'text' : 'password'}
        value={value}
        placeholder={placeholder ?? '例如 Authorization: Bearer sk-xxx'}
        spellCheck={false}
        onChange={(e) => onChange?.(e.target.value)}
      />
      <Button type="default" onClick={() => setShow((s) => !s)} title={show ? '隐藏' : '显示'}>
        {show ? <EyeInvisibleOutlined /> : <EyeOutlined />}
      </Button>
    </Input.Group>
  );
}

type ProbeStatus = { loading?: boolean; ok?: boolean; detail?: string };

export default function SettingsPage() {
  const [ocrForm] = Form.useForm();
  const [loading, setLoading] = useState(true);

  const [profiles, setProfiles] = useState<LlmProfile[]>([]);
  const [defaultId, setDefaultId] = useState('');
  const [concurrency, setConcurrency] = useState(2);
  const loadedOcr = useRef<{ ocrBase: string | null; ocrExtraHeader: string }>({ ocrBase: null, ocrExtraHeader: '' });
  const [llmStatus, setLlmStatus] = useState<Record<string, ProbeStatus>>({});
  const [ocrStatus, setOcrStatus] = useState<ProbeStatus | null>(null);
  const [saving, setSaving] = useState(false);

  const [modelOptions, setModelOptions] = useState<Record<string, { value: string }[]>>({});
  const [fetchingId, setFetchingId] = useState<string | null>(null);

  /* M4 分类集管理 */
  const [cats, setCats] = useState<string[]>([]);
  const [newCat, setNewCat] = useState('');
  const [autoCat, setAutoCat] = useState(true);

  useEffect(() => {
    api
      .getSettings()
      .then((s) => {
        setProfiles(s.llmProfiles ?? []);
        setDefaultId(s.defaultLlmId || s.llmProfiles?.[0]?.id || '');
        setConcurrency(s.llmConcurrency);
        loadedOcr.current = { ocrBase: s.ocrBase ?? null, ocrExtraHeader: s.ocrExtraHeader ?? '' };
        ocrForm.setFieldsValue({ ocrBase: s.ocrBase ?? '', ocrExtraHeader: s.ocrExtraHeader ?? '' });
        setAutoCat(s.autoCategorize);
        setLoading(false);
      })
      .catch((e) => {
        message.error((e as Error).message);
        setLoading(false);
      });
    api
      .getCategories()
      .then((r) => setCats(r.categories))
      .catch(() => undefined);
  }, [ocrForm]);

  const patchProfile = (id: string, patch: Partial<LlmProfile>) => {
    setProfiles((list) => list.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  };

  const addProfile = () => {
    const id = `llm-${Date.now().toString(36)}`;
    setProfiles((list) => [
      ...list,
      { id, name: '', base: 'http://127.0.0.1:8005/v1', model: '', extraHeader: '' },
    ]);
    setDefaultId((cur) => cur || id);
  };

  const removeProfile = (id: string) => {
    setProfiles((list) => {
      const next = list.filter((p) => p.id !== id);
      setDefaultId((cur) => (cur === id ? next[0]?.id ?? '' : cur));
      return next;
    });
  };

  /** 拉取这一套端点上的可用模型，填进模型名 */
  const fetchModels = async (id: string) => {
    const p = profiles.find((x) => x.id === id);
    if (!p?.base) {
      message.warning('请先填 LLM 端点');
      return;
    }
    setFetchingId(id);
    try {
      const r = (await api.llmModels({ llmBase: p.base, llmExtraHeader: p.extraHeader })) as LlmModelsResult;
      if (r.ok && r.models.length > 0) {
        setModelOptions((prev) => ({ ...prev, [id]: r.models.map((m) => ({ value: m })) }));
        if (!p.model || !r.models.includes(p.model)) {
          patchProfile(id, { model: r.models[0] });
          message.info(`已填入可用模型：${r.models[0]}`);
        } else {
          message.success(`获取成功，共 ${r.models.length} 个模型`);
        }
      } else {
        message.warning(r.detail || '端点可达但未返回模型列表');
      }
    } catch (e) {
      message.error(`获取失败：${(e as Error).message}`);
    } finally {
      setFetchingId(null);
    }
  };

  const testLlm = async (id: string) => {
    const p = profiles.find((x) => x.id === id);
    if (!p?.base) {
      message.warning('请先填 LLM 端点');
      return;
    }
    setLlmStatus((prev) => ({ ...prev, [id]: { loading: true } }));
    try {
      const [r, models] = await Promise.all([
        api.probeLlm({ llmBase: p.base, llmModel: p.model, llmExtraHeader: p.extraHeader }),
        api.llmModels({ llmBase: p.base, llmExtraHeader: p.extraHeader }).catch(() => null),
      ]);
      if (models && models.ok && models.models.length > 0) {
        setModelOptions((prev) => ({ ...prev, [id]: models.models.map((m) => ({ value: m })) }));
        if (!p.model || !models.models.includes(p.model)) {
          patchProfile(id, { model: models.models[0] });
          setLlmStatus((prev) => ({
            ...prev,
            [id]: { loading: false, ok: r.ok, detail: `端点可达。已自动填入当前可用模型：${models.models[0]}` },
          }));
          return;
        }
      }
      setLlmStatus((prev) => ({ ...prev, [id]: { loading: false, ok: r.ok, detail: r.detail } }));
    } catch (e) {
      setLlmStatus((prev) => ({ ...prev, [id]: { loading: false, ok: false, detail: (e as Error).message } }));
    }
  };

  const testOcr = async () => {
    const v = ocrForm.getFieldsValue();
    if (!v.ocrBase) {
      message.warning('请先填 OCR 端点');
      return;
    }
    setOcrStatus({ loading: true });
    try {
      const r = await api.probeOcr({ ocrBase: v.ocrBase, ocrExtraHeader: v.ocrExtraHeader });
      setOcrStatus({ loading: false, ok: r.ok, detail: r.detail });
    } catch (e) {
      setOcrStatus({ loading: false, ok: false, detail: (e as Error).message });
    }
  };

  const save = async () => {
    if (profiles.length === 0) {
      message.warning('至少保留一个模型');
      return;
    }
    for (const p of profiles) {
      if (!p.name.trim() || !p.base.trim() || !p.model.trim()) {
        message.warning(`「${p.name.trim() || '未命名模型'}」要填名称、端点和模型名`);
        return;
      }
    }
    const rawBase = ocrForm.getFieldValue('ocrBase') as string | null | undefined;
    const rawHeader = ocrForm.getFieldValue('ocrExtraHeader') as string | null | undefined;
    const ocrBase = rawBase === undefined ? loadedOcr.current.ocrBase : rawBase || null;
    const ocrExtraHeader = rawHeader === undefined ? loadedOcr.current.ocrExtraHeader : rawHeader ?? '';
    const savedProfiles = profiles.map((p) => ({
      ...p,
      name: p.name.trim(),
      base: p.base.trim(),
      model: p.model.trim(),
    }));
    setSaving(true);
    try {
      await api.putSettings({
        llmBase: '',
        llmModel: '',
        llmExtraHeader: '',
        llmProfiles: savedProfiles,
        defaultLlmId: savedProfiles.some((p) => p.id === defaultId) ? defaultId : savedProfiles[0].id,
        ocrBase: (ocrBase ?? null) as unknown as string,
        ocrExtraHeader,
        llmConcurrency: concurrency,
        autoCategorize: autoCat,
      } satisfies FlowSettings);
      loadedOcr.current = { ocrBase, ocrExtraHeader };
      await api.putCategories(cats);
      message.success('设置已保存，立即生效');
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <Spin />;

  return (
    <Space direction="vertical" size={0} style={{ width: '100%' }}>
      <Card size="small" style={{ borderRadius: 8 }}>
        <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 0 }}>
          可以登记多套 LLM，每套有自己的地址、模型名和鉴权。解析前从这里选。标成默认的那套，用于新文件自动解析和分类。
          OCR 仍是单独一套。需要鉴权时在「自定义请求头」里填（格式：名称: 值）。
        </Typography.Paragraph>
        <Tabs
          items={[
            {
              key: 'llm',
              label: (
                <span>
                  <CloudOutlined /> LLM 模型
                </span>
              ),
              children: (
                <div style={{ maxWidth: 720 }}>
                  <Space direction="vertical" size={12} style={{ width: '100%' }}>
                    {profiles.map((p) => (
                      <Card
                        key={p.id}
                        size="small"
                        style={{
                          borderColor: p.id === defaultId ? 'var(--ui-primary-border)' : undefined,
                          background: p.id === defaultId ? 'var(--ui-primary-soft)' : undefined,
                        }}
                      >
                        <Space direction="vertical" size={8} style={{ width: '100%' }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                            <Checkbox checked={p.id === defaultId} onChange={() => setDefaultId(p.id)}>
                              默认（新文件自动解析和分类用这个）
                            </Checkbox>
                            <Button
                              type="text"
                              danger
                              icon={<DeleteOutlined />}
                              disabled={profiles.length <= 1}
                              onClick={() => removeProfile(p.id)}
                            >
                              删除
                            </Button>
                          </div>
                          <div>
                            <Typography.Text>名称</Typography.Text>
                            <Input
                              value={p.name}
                              placeholder="例如 局域网 Qwen"
                              onChange={(e) => patchProfile(p.id, { name: e.target.value })}
                            />
                          </div>
                          <div>
                            <Typography.Text>LLM 端点（vLLM，OpenAI 兼容）</Typography.Text>
                            <Input
                              value={p.base}
                              placeholder="http://127.0.0.1:8005/v1 或 https://your-llm.example.com/v1"
                              spellCheck={false}
                              onChange={(e) => patchProfile(p.id, { base: e.target.value })}
                            />
                          </div>
                          <div>
                            <Typography.Text>模型名</Typography.Text>
                            <Space.Compact style={{ width: '100%' }}>
                              <AutoComplete
                                style={{ flex: 1 }}
                                options={modelOptions[p.id] ?? []}
                                value={p.model}
                                placeholder="例如 qwen3-vl"
                                allowClear
                                onChange={(v) => patchProfile(p.id, { model: v })}
                              />
                              <Button
                                loading={fetchingId === p.id}
                                icon={<ReloadOutlined />}
                                onClick={() => fetchModels(p.id)}
                              >
                                拉取模型列表
                              </Button>
                            </Space.Compact>
                            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                              可手动输入，或点「拉取模型列表」从端点自动获取
                            </Typography.Text>
                          </div>
                          <div>
                            <Typography.Text>自定义请求头（可选）</Typography.Text>
                            <HeaderInput
                              value={p.extraHeader}
                              placeholder="例如 Authorization: Bearer sk-xxx"
                              onChange={(v) => patchProfile(p.id, { extraHeader: v })}
                            />
                            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                              端点需要鉴权时填，格式：名称: 值
                            </Typography.Text>
                          </div>
                          <Button icon={<ApiOutlined />} loading={!!llmStatus[p.id]?.loading} onClick={() => testLlm(p.id)}>
                            测试这个模型
                          </Button>
                          <StatusLine status={llmStatus[p.id] ?? null} />
                        </Space>
                      </Card>
                    ))}
                    <Button icon={<PlusOutlined />} onClick={addProfile}>
                      添加模型
                    </Button>
                    <div>
                      <Typography.Text>LLM 并发数</Typography.Text>
                      <div>
                        <InputNumber min={1} max={4} value={concurrency} style={{ width: 120 }} onChange={(v) => setConcurrency(Number(v) || 1)} />
                      </div>
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        同时跑的 LLM 解析任务数，各模型共用
                      </Typography.Text>
                    </div>
                  </Space>
                </div>
              ),
            },
            {
              key: 'ocr',
              label: (
                <span>
                  <ScanOutlined /> OCR 服务
                </span>
              ),
              children: (
                <div style={{ maxWidth: 640 }}>
                  <Form form={ocrForm} layout="vertical">
                    <Form.Item
                      label="OCR 端点（PP-OCRv6）"
                      name="ocrBase"
                      rules={[{ required: true, message: '请输入 OCR 端点' }]}
                      extra="填到根地址即可，无需 /health、/ocr 等路径后缀"
                    >
                      <Input placeholder="http://127.0.0.1:8008 或 https://your-ocr.example.com" spellCheck={false} />
                    </Form.Item>
                    <Form.Item
                      label="自定义请求头（可选）"
                      name="ocrExtraHeader"
                      extra="同 LLM，OCR 端点需要鉴权时填"
                    >
                      <HeaderInput placeholder="例如 X-Api-Key: abc" />
                    </Form.Item>
                    <Space>
                      <Button type="primary" icon={<ApiOutlined />} onClick={() => testOcr()}>
                        测试 OCR
                      </Button>
                    </Space>
                  </Form>
                  <StatusLine status={ocrStatus} />
                </div>
              ),
            },
            {
              key: 'categories',
              label: (
                <span>
                  <TagsOutlined /> 分类集
                </span>
              ),
              children: (
                <div style={{ maxWidth: 640 }}>
                  <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
                    LLM 批量逐笔分类只能从这里选；人工改判会作为示例喂给下一批。默认是募集资金专户分类集，可按需改。
                  </Typography.Paragraph>
                  <Checkbox checked={autoCat} onChange={(e) => setAutoCat(e.target.checked)} style={{ marginBottom: 12 }}>
                    解析完成后自动 LLM 分类
                  </Checkbox>
                  <Space wrap>
                    {cats.map((c) => (
                      <Space key={c} size={4}>
                        <Input
                          size="small"
                          style={{ width: 130 }}
                          value={c}
                          placeholder="分类名"
                          title={CATEGORY_DEFS[c] ? `默认定义：${CATEGORY_DEFS[c]}` : '自定义分类，按名称含义归类'}
                          onChange={(e) =>
                            setCats((cs) =>
                              cs.map((x) => (x === c ? e.target.value.trim() : x)).filter((x, i, a) => x && a.indexOf(x) === i),
                            )
                          }
                        />
                        <Button
                          size="small"
                          type="text"
                          danger
                          icon={<DeleteOutlined />}
                          onClick={() => setCats((cs) => cs.filter((x) => x !== c))}
                        />
                      </Space>
                    ))}
                  </Space>
                  <Space style={{ marginTop: 8 }}>
                    <Input
                      size="small"
                      style={{ width: 150 }}
                      placeholder="新增分类"
                      value={newCat}
                      onChange={(e) => setNewCat(e.target.value)}
                      onPressEnter={() => {
                        const v = newCat.trim();
                        if (v && !cats.includes(v)) setCats((cs) => [...cs, v]);
                        setNewCat('');
                      }}
                    />
                    <Button
                      size="small"
                      icon={<PlusOutlined />}
                      onClick={() => {
                        const v = newCat.trim();
                        if (v && !cats.includes(v)) setCats((cs) => [...cs, v]);
                        setNewCat('');
                      }}
                    >
                      添加
                    </Button>
                  </Space>
                </div>
              ),
            },
          ]}
        />
      </Card>

      <Card size="small" style={{ borderTopLeftRadius: 0 }}>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 16,
            flexWrap: 'wrap',
          }}
        >
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            提示：改完要点保存。解析前会让你选这里的某一套；没弹窗的自动解析用标为默认的那套。
          </Typography.Text>
          <Button type="primary" icon={<SaveOutlined />} loading={saving} onClick={() => save()}>
            保存设置
          </Button>
        </div>
      </Card>
    </Space>
  );
}
