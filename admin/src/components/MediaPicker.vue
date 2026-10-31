<template>
  <el-dialog
    :model-value="modelValue"
    title="从文件管理中选取"
    width="880px"
    top="6vh"
    @update:model-value="(v) => emit('update:modelValue', v)"
    @open="onOpen"
  >
    <div class="mp">
      <div class="mp-bar">
        <el-select v-model="groupId" style="width: 168px" @change="loadList">
          <el-option label="全部图片" value="all" />
          <el-option label="未分组" :value="0" />
          <el-option v-for="g in groups" :key="g.group_id" :label="`${g.name}（${g.count}）`" :value="g.group_id" />
        </el-select>
        <el-input v-model="keyword" placeholder="搜索文件名" clearable style="width: 200px" @clear="loadList" @keyup.enter="loadList" />
        <el-button @click="loadList">搜索</el-button>
        <span class="spacer" />
        <el-button @click="fileEl?.click()">上传新图片</el-button>
        <input ref="fileEl" type="file" accept="image/*" multiple style="display: none" @change="onPickFiles" />
      </div>

      <div v-loading="loading" class="mp-body">
        <div v-if="list.length" class="mp-grid">
          <div
            v-for="f in list"
            :key="f.file_id"
            class="mp-item"
            :class="{ on: chosen.includes(f.url) }"
            @click="toggle(f.url)"
          >
            <img v-if="!failed.has(f.file_id)" :src="f.url" alt="" loading="lazy" @error="failed.add(f.file_id)" />
            <div v-else class="mp-broken">无法预览</div>
            <span v-if="chosen.includes(f.url)" class="mp-check">✓</span>
            <span class="mp-name" :title="`${f.name}.${f.ext}`">{{ f.name }}</span>
          </div>
        </div>
        <div v-else-if="!loading" class="mp-empty">
          这个分组还没有图片，可以点右上角「上传新图片」，或去「文件管理」里整理
        </div>
      </div>

      <div class="mp-foot">
        <span class="mp-tip">
          {{ multiple ? `可多选，已选 ${chosen.length}${limit ? ` / ${limit}` : ''}` : '点一下选中，再点一次取消' }}
        </span>
        <el-pagination
          v-if="total > pageSize"
          layout="prev, pager, next"
          small
          :total="total"
          :page-size="pageSize"
          :current-page="page"
          @current-change="(p) => { page = p; loadList(); }"
        />
      </div>
    </div>

    <template #footer>
      <el-button @click="emit('update:modelValue', false)">取消</el-button>
      <el-button type="primary" :disabled="!chosen.length" @click="confirm">
        {{ chosen.length ? `使用选中的 ${chosen.length} 张` : '使用选中图片' }}
      </el-button>
    </template>
  </el-dialog>
</template>

<script setup>
import { reactive, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { adminApi } from '../api.js';

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  multiple: { type: Boolean, default: false },
  limit: { type: Number, default: 0 },
});
const emit = defineEmits(['update:modelValue', 'pick', 'upload-files']);

const fileEl = ref(null);
const loading = ref(false);
const list = ref([]);
const total = ref(0);
const page = ref(1);
const pageSize = 40;
const keyword = ref('');
const groupId = ref('all');
const groups = ref([]);
const chosen = ref([]);
// 坏图（截断/损坏的上传）记下来换成占位，避免浏览器画成破图标把网格撑高
const failed = reactive(new Set());

async function loadGroups() {
  try {
    const r = await adminApi.mediaGroups();
    groups.value = r.data?.groups || [];
  } catch {}
}

async function loadList() {
  loading.value = true;
  try {
    const r = await adminApi.mediaList({
      group_id: groupId.value === 'all' ? undefined : groupId.value,
      keyword: keyword.value || undefined,
      page: page.value,
      limit: pageSize,
    });
    list.value = r.data?.list || [];
    total.value = Number(r.data?.total || 0);
  } catch {
    list.value = [];
    total.value = 0;
  } finally {
    loading.value = false;
  }
}

function onOpen() {
  chosen.value = [];
  failed.clear();
  page.value = 1;
  keyword.value = '';
  loadGroups();
  loadList();
}

function toggle(url) {
  if (!props.multiple) {
    chosen.value = chosen.value[0] === url ? [] : [url];
    return;
  }
  const i = chosen.value.indexOf(url);
  if (i >= 0) chosen.value.splice(i, 1);
  else if (props.limit && chosen.value.length >= props.limit) ElMessage.warning(`最多再选 ${props.limit} 张`);
  else chosen.value.push(url);
}

function onPickFiles(e) {
  const files = [...(e.target.files || [])];
  e.target.value = '';
  if (!files.length) return;
  emit('upload-files', files, groupId.value === 'all' ? 0 : groupId.value);
  emit('update:modelValue', false);
}

function confirm() {
  emit('pick', [...chosen.value]);
  emit('update:modelValue', false);
}
</script>

<style scoped>
.mp-bar { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; flex-wrap: wrap; }
.mp-bar .spacer { flex: 1; }
.mp-body { min-height: 320px; max-height: 52vh; overflow: auto; }
.mp-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(112px, 1fr)); gap: 10px; }
.mp-item {
  position: relative;
  border: 1px solid #eceff3;
  border-radius: 10px;
  padding: 6px;
  cursor: pointer;
  transition: border-color 0.16s, box-shadow 0.16s;
}
.mp-item:hover { border-color: #ffcdc5; }
.mp-item.on { border-color: #ff513a; box-shadow: 0 0 0 2px rgba(255, 81, 58, 0.14); }
.mp-item img { width: 100%; height: 84px; object-fit: cover; border-radius: 7px; background: #f7f8fa; display: block; }
.mp-broken {
  height: 84px; border-radius: 7px; background: #f7f8fa;
  display: flex; align-items: center; justify-content: center;
  font-size: 11px; color: #b9bfc9;
}
.mp-check {
  position: absolute; top: 10px; right: 10px;
  width: 19px; height: 19px; border-radius: 50%;
  background: #ff513a; color: #fff; font-size: 12px;
  display: flex; align-items: center; justify-content: center;
}
.mp-name {
  display: block; font-size: 11.5px; color: #626a76; margin-top: 5px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.mp-empty { text-align: center; color: #a8adb7; font-size: 12.5px; padding: 80px 0; line-height: 1.7; }
.mp-foot { display: flex; align-items: center; justify-content: space-between; margin-top: 12px; }
.mp-tip { font-size: 12px; color: #8c93a0; }
</style>
