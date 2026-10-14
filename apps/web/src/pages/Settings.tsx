import { useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Form,
  Input,
  InputNumber,
  Space,
  Spin,
  Typography,
  message,
} from 'antd';
import { ApiOutlined, SaveOutlined } from '@ant-design/icons';
import { ProbeResult, Settings } from '@flow/shared';
import { api } from '../api';

export default function SettingsPage() {
  const [form] = Form.useForm<Settings>();
  const [loading, setLoading] = useState(true);
  const [probing, setProbing] = useState(false);
  const [probeResult, setProbeResult] = useState<{ llm: ProbeResult; ocr: ProbeResult } | null>(null);

  useEffect(() => {
    api
      .getSettings()
      .then((s) => {
        form.setFieldsValue(s);
        setLoading(false);
      })
      .catch((e) => {
        message.error((e as Error).message);
        setLoading(false);
      });
  }, [form]);

  const save = async () => {
    try {
      const s = await form.validateFields();
      await api.putSettings(s);
      message.success('设置已保存');
    } catch (e) {
      if ((e as { errorFields?: unknown[] }).errorFields) return; // 表单校验
      message.error((e as Error).message);
    }
  };

  const probe = async () => {
    const s = form.getFieldsValue();
    setProbing(true);
    setProbeResult(null);
    try {
      setProbeResult(await api.probe(s));
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setProbing(false);
    }
  };

  if (loading) return <Spin />;

  const alert = (r: ProbeResult, title: string) => (
    <Alert
      key={title}
      type={r.ok ? 'success' : 'error'}
      showIcon
      message={title}
      description={r.detail}
    />
  );

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card title="AI 服务端点（局域网算力舱）" size="small">
        <Form form={form} layout="vertical" style={{ maxWidth: 640 }}>
          <Form.Item label="LLM 端点（vLLM，OpenAI 兼容）" name="llmBase" rules={[{ required: true }]}>
            <Input placeholder="http://192.168.1.17:8005/v1" />
          </Form.Item>
          <Form.Item
            label="LLM 模型名"
            name="llmModel"
            rules={[{ required: true }]}
            extra="不确定就点「测试连接」，会提示当前可用模型"
          >
            <Input placeholder="qwen-3.8-27b-uncensored" />
          </Form.Item>
          <Form.Item label="OCR 端点（PP-OCRv6）" name="ocrBase" rules={[{ required: true }]}>
            <Input placeholder="http://192.168.1.17:8008" />
          </Form.Item>
          <Form.Item label="LLM 并发数" name="llmConcurrency" extra="同时跑的 LLM 解析任务数">
            <InputNumber min={1} max={4} style={{ width: 120 }} />
          </Form.Item>
          <Space>
            <Button icon={<SaveOutlined />} type="primary" onClick={save}>
              保存
            </Button>
            <Button icon={<ApiOutlined />} onClick={probe} loading={probing}>
              测试连接
            </Button>
          </Space>
        </Form>
      </Card>

      {probeResult && (
        <Card size="small" title="连接测试结果">
          <Space direction="vertical" size={8}>
            {alert(probeResult.llm, 'LLM（Qwen）')}
            {alert(probeResult.ocr, 'OCR（PP-OCRv6）')}
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              提示：模型服务可能被懒猫平台切换，若 LLM 提示模型不在列表，请按提示更新模型名后保存。
            </Typography.Text>
          </Space>
        </Card>
      )}
    </Space>
  );
}
