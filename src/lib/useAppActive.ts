import { useEffect, useState } from 'react';
import { AppState } from 'react-native';

/** App 是否在前台（省电优化 #4：后台 / 锁屏时停止界面定时刷新） */
export function useAppActive(): boolean {
  const [active, setActive] = useState(AppState.currentState === 'active');
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => setActive(s === 'active'));
    return () => sub.remove();
  }, []);
  return active;
}
