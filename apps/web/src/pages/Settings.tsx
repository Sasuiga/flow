import { useEffect, useState } from 'react';
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
  KeyOutlined,
  PlusOutlined,
  ReloadOutlined,
  SaveOutlined,
  ScanOutlined,
  TagsOutlined,
  DeleteOutlined,
} from '@ant-design/icons';
import { CATEGORY_DEFS, Settings as FlowSettings } from '@flow/shared';
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

export default function SettingsPage() {
  const [llmForm] = Form.useForm();
  const [ocrForm] = Form.useForm();
  const [loading, setLoading] = useState(true);

  const [llmStatus, setLlmStatus] = useState<{ loading?: boolean; ok?: boolean; detail?: string } | null>(null);
  const [ocrStatus, setOcrStatus] = useState<{ loading?: boolean; ok?: boolean; detail?: string } | null>(null);
  const [saving, setSaving] = useState(false);

  const [modelOptions, setModelOptions] = useState<{ value: string }[]>([]);
  const [fetchingModels, setFetchingModels] = useState(false);

  /* M4 分类集管理 */
  const [cats, setCats] = useState<string[]>([]);
  const [newCat, setNewCat] = useState('');
  const [autoCat, setAutoCat] = useState(true);

  useEffect(() => {
    api
      .getSettings()
      .then((s) => {
        llmForm.setFieldsValue({
          llmBase: s.llmBase,
          llmModel: s.llmModel,
          llmExtraHeader: s.llmExtraHeader,
          llmConcurrency: s.llmConcurrency,
        });
        ocrForm.setFieldsValue({ ocrBase: s.ocrBase, ocrExtraHeader: s.ocrExtraHeader });
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
  }, [llmForm, ocrForm]);

  /** 拉取端点上的可用模型，填进模型名下拉 */
  const fetchModels = async (useValues: boolean) => {
    const v = llmForm.getFieldsValue();
    const body = useValues ? { llmBase: v.llmBase, llmExtraHeader: v.llmExtraHeader } : {};
    setFetchingModels(true);
    try {
      const r = (await api.llmModels(body)) as LlmModelsResult;
      if (r.ok && r.models.length > 0) {
        setModelOptions(r.models.map((m) => ({ value: m })));
        const cur = llmForm.getFieldValue('llmModel');
        if (!cur || !r.models.includes(cur)) {
          llmForm.setFieldValue('llmModel', r.models[0]);
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
      setFetchingModels(false);
    }
  };

  const testLlm = async () => {
    const v = llmForm.getFieldsValue();
    if (!v.llmBase) {
      message.warning('请先填 LLM 端点');
      return;
    }
    setLlmStatus({ loading: true });
    try {
      const [r, models] = await Promise.all([
        api.probeLlm({ llmBase: v.llmBase, llmModel: v.llmModel, llmExtraHeader: v.llmExtraHeader }),
        api.llmModels({ llmBase: v.llmBase, llmExtraHeader: v.llmExtraHeader }).catch(() => null),
      ]);
      if (models && models.ok && models.models.length > 0) {
        setModelOptions(models.models.map((m) => ({ value: m })));
        if (!v.llmModel || !models.models.includes(v.llmModel)) {
          llmForm.setFieldValue('llmModel', models.models[0]);
          setLlmStatus({ loading: false, ok: r.ok, detail: `端点可达。已自动填入当前可用模型：${models.models[0]}` });
        } else {
          setLlmStatus({ loading: false, ok: r.ok, detail: r.detail });
        }
      } else {
        setLlmStatus({ loading: false, ok: r.ok, detail: r.detail });
      }
    } catch (e) {
      setLlmStatus({ loading: false, ok: false, detail: (e as Error).message });
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
    let llm: Record<string, unknown>;
    let ocr: Record<string, unknown>;
    try {
      llm = await llmForm.validateFields();
      ocr = await ocrForm.validateFields();
    } catch {
      message.warning('表单必填项未完成（红星字段）');
      return;
    }
    setSaving(true);
    try {
      await api.putSettings({ ...llm, ...ocr, autoCategorize: autoCat } as unknown as FlowSettings);
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
          分别配置 LLM（大模型）与 OCR（文字识别）两个服务，「测试」通过后再保存。不在同一局域网时填外网穿透地址；
          需要鉴权时在「自定义请求头」里填（格式：名称: 值）。
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
                <div style={{ maxWidth: 640 }}>
                  <Form form={llmForm} layout="vertical">
                    <Form.Item
                      label="LLM 端点（vLLM，OpenAI 兼容）"
                      name="llmBase"
                      rules={[{ required: true, message: '请输入 LLM 端点' }]}
                    >
                      <Input placeholder="http://127.0.0.1:8005/v1 或 https://your-llm.example.com/v1" spellCheck={false} />
                    </Form.Item>
                    <Form.Item
                      label="模型名"
                      name="llmModel"
                      rules={[{ required: true, message: '请输入模型名' }]}
                      extra="可手动输入，或点「拉取模型列表」从端点自动获取"
                    >
                      <Space.Compact style={{ width: '100%' }}>
                        <AutoComplete
                          style={{ flex: 1 }}
                          options={modelOptions}
                          placeholder="例如 qwen3-vl"
                          allowClear
                        />
                        <Button
                          loading={fetchingModels}
                          icon={<ReloadOutlined />}
                          onClick={() => fetchModels(true)}
                        >
                          拉取模型列表
                        </Button>
                      </Space.Compact>
                    </Form.Item>
                    <Form.Item
                      label="自定义请求头（可选）"
                      name="llmExtraHeader"
                      extra="端点需要鉴权时填，格式：名称: 值，例如 Authorization: Bearer sk-xxx"
                    >
                      <HeaderInput placeholder="例如 Authorization: Bearer sk-xxx" />
                    </Form.Item>
                    <Form.Item label="LLM 并发数" name="llmConcurrency" extra="同时跑的 LLM 解析任务数">
                      <InputNumber min={1} max={4} style={{ width: 120 }} />
                    </Form.Item>
                    <Space>
                      <Button type="primary" icon={<ApiOutlined />} onClick={() => testLlm()}>
                        测试 LLM
                      </Button>
                      <Button onClick={() => fetchModels(true)} loading={fetchingModels} icon={<KeyOutlined />}>
                        仅拉取模型
                      </Button>
                    </Space>
                  </Form>
                  <StatusLine status={llmStatus} />
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
            提示：模型服务可能由平台切换，若 LLM 测试提示模型不在列表，请按提示里的可用模型名更新后保存。
          </Typography.Text>
          <Button type="primary" icon={<SaveOutlined />} loading={saving} onClick={() => save()}>
            保存设置
          </Button>
        </div>
      </Card>
    </Space>
  );
}
