// 先打开数据库、注册后台定位任务（必须在全局作用域），再启动路由
import './src/db/database';
import './src/tracking/task';
import 'expo-router/entry';
