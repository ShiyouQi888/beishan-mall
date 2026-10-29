<template>
  <div>
    <div class="page-head">
      <div>
        <h2>节点管理</h2>
        <div class="desc">系统权限节点由菜单结构自动同步，角色可在「角色管理 → 分配权限」中勾选</div>
      </div>
      <el-button @click="load">刷新</el-button>
    </div>

    <div class="panel" v-loading="loading">
      <div class="node-list">
        <div class="node-group" v-for="g in tree" :key="g.id">
          <div class="group-head">
            <span class="dot" />
            <span class="g-name">{{ g.name }}</span>
            <span class="g-count">{{ g.children.length }} 项</span>
          </div>
          <div class="group-body">
            <div class="node-item" v-for="c in g.children" :key="c.id">
              <span class="n-name">{{ c.name }}</span>
              <span class="n-path">{{ c.path }}</span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div class="tip">
      <span class="dot" />
      超级管理员（role_id = 6）默认拥有全部权限，不受节点限制；其他角色需在角色管理里分配。
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import { ElMessage } from 'element-plus';
import http from '../api.js';

const tree = ref([]);
const loading = ref(false);

async function load() {
  loading.value = true;
  try {
    const r = await http.get('/node/tree');
    tree.value = r.data?.tree || [];
  } catch {
    ElMessage.error('加载失败');
  } finally {
    loading.value = false;
  }
}

onMounted(load);
</script>

<style scoped>
.node-list { display: flex; flex-direction: column; gap: 14px; }
.node-group {
  border: 1px solid #eef1f5;
  border-radius: 10px;
  overflow: hidden;
}
.group-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 11px 14px;
  background: #fafbfc;
  font-size: 13.5px;
  font-weight: 600;
}
.group-head .dot {
  width: 6px; height: 6px; border-radius: 50%;
  background: #ff513a;
}
.g-count { margin-left: auto; font-size: 11.5px; color: #a8adb7; font-weight: 450; }

.group-body {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 1px;
  background: #eef1f5;
}
.node-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  background: #fff;
  padding: 10px 14px;
}
.n-name { font-size: 13px; color: #34383f; }
.n-path {
  font-size: 11.5px;
  color: #a8adb7;
  font-family: ui-monospace, Menlo, Consolas, monospace;
}

.tip {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 12px;
  font-size: 12px;
  color: #8c93a0;
}
.tip .dot { width: 6px; height: 6px; border-radius: 50%; background: #ff513a; opacity: 0.6; }
</style>
