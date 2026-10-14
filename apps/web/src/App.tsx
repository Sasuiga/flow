import { useState } from 'react';
import { Layout, Menu, Typography, theme } from 'antd';
import {
  DashboardOutlined,
  ProfileOutlined,
  AlertOutlined,
  TeamOutlined,
  AuditOutlined,
  SettingOutlined,
} from '@ant-design/icons';
import Dashboard from './pages/Dashboard';
import SettingsPage from './pages/Settings';
import Placeholder from './pages/Placeholder';

type Key = 'dashboard' | 'tx' | 'review' | 'subjects' | 'rules' | 'settings';

const MENU: { key: Key; label: string; icon: React.ReactNode }[] = [
  { key: 'dashboard', label: '项目看板', icon: <DashboardOutlined /> },
  { key: 'tx', label: '交易浏览器', icon: <ProfileOutlined /> },
  { key: 'review', label: '修正队列', icon: <AlertOutlined /> },
  { key: 'subjects', label: '主体与关联方', icon: <TeamOutlined /> },
  { key: 'rules', label: '规则', icon: <AuditOutlined /> },
  { key: 'settings', label: '设置', icon: <SettingOutlined /> },
];

export default function App() {
  const [key, setKey] = useState<Key>('dashboard');
  const { token } = theme.useToken();

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Layout.Sider width={210} theme="dark">
        <div style={{ padding: '18px 16px', color: '#fff' }}>
          <Typography.Text strong style={{ fontSize: 18, color: '#fff' }}>
            flow
          </Typography.Text>
          <div style={{ fontSize: 12, color: 'rgba(255,255,255,.55)' }}>银行流水核查工作台</div>
        </div>
        <Menu
          theme="dark"
          mode="inline"
          selectedKeys={[key]}
          items={MENU}
          onClick={(e) => setKey(e.key as Key)}
        />
      </Layout.Sider>
      <Layout>
        <Layout.Content style={{ margin: 16, padding: 20, background: token.colorBgContainer, borderRadius: token.borderRadiusLG }}>
          {key === 'dashboard' && <Dashboard />}
          {key === 'tx' && <Placeholder name="交易浏览器" note="M2 交付：跨项目交易表格（过滤/排序/分页/下钻原始文本）" />}
          {key === 'review' && <Placeholder name="修正队列" note="M3 交付：余额校验/低置信行的集中修正界面" />}
          {key === 'subjects' && <Placeholder name="主体与关联方" note="M4 交付：主体/关联方/别名登记 + 对手方自动匹配" />}
          {key === 'rules' && <Placeholder name="规则" note="M5 交付：R1~R5 开关与参数、命中明细、确认/误报标记" />}
          {key === 'settings' && <SettingsPage />}
        </Layout.Content>
      </Layout>
    </Layout>
  );
}
