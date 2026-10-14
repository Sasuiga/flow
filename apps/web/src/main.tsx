import React from 'react';
import { createRoot } from 'react-dom/client';
import { ConfigProvider, theme as antdTheme } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import dayjs from 'dayjs';
import 'dayjs/locale/zh-cn';
import 'antd/dist/reset.css';
import App from './App';
import './styles/flow.css';

dayjs.locale('zh-cn');

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ConfigProvider
      locale={zhCN}
      theme={{
        // Avalon 设计令牌对齐：AntD 组件（设置页表单）统一观感
        token: {
          colorPrimary: '#3d5ccc',
          colorInfo: '#3d5ccc',
          colorError: '#c43d48',
          colorSuccess: '#2a8f56',
          colorWarning: '#8a6a1f',
          colorTextBase: '#1b1d24',
          colorBgLayout: '#f4f4f5',
          colorBgContainer: '#ffffff',
          colorBorder: 'rgba(28, 34, 48, 0.13)',
          borderRadius: 6,
          fontSize: 13,
          fontFamily:
            '"Segoe UI Variable Text", "Segoe UI", "PingFang SC", "Microsoft YaHei UI", "Microsoft YaHei", sans-serif',
          wireframe: false,
        },
        algorithm: antdTheme.defaultAlgorithm,
      }}
    >
      <App />
    </ConfigProvider>
  </React.StrictMode>,
);
