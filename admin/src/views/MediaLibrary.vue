<template>
  <div>
    <div class="page-head">
      <div>
        <h2>文件管理</h2>
        <div class="desc">这里管理所有上传过的图片，商品、广告、配置里都能直接从这里选，不用重复上传</div>
      </div>
      <div class="head-actions">
        <el-button @click="load()">刷新</el-button>
        <el-button @click="openGroupDlg()">新建分组</el-button>
        <el-button type="primary" :loading="uploading" @click="fileEl?.click()">上传图片</el-button>
        <input ref="fileEl" type="file" accept="image/*" multiple style="display: none" @change="onPickFiles" />
      </div>
    </div>

    <div class="layout">
      <!-- 分组 -->
      <div class="panel rail">
        <div class="rail-total">
          <span>全部素材</span>
          <b>{{ groups.total || 0 }}</b>
        </div>
        <div
          class="rail-item"
          :class="{ on: activeGroup === '' }"
          @click="switchGroup('')"
        >
          <span>全部图片</span><em>{{ groups.total || 0 }}</em>
        </div>
        <div
          class="rail-item"
          :class="{ on: activeGroup === 0 }"
          @click="switchGroup(0)"
        >
          <span>未分组</span><em>{{ groups.ungrouped || 0 }}</em>
        </div>
        <div class="rail-title">分组</div>
        <div
          v-for="g in groups.groups || []"
          :key="g.group_id"
          class="rail-item"
          :class="{ on: activeGroup === g.group_id }"
          @click="switchGroup(g.group_id)"
        >
          <span class="rail-name" :title="g.name">{{ g.name }}</span>
          <em>{{ g.count }}</em>
          <span class="rail-ops" @click.stop>
            <a @click="openGroupDlg(g)">改名</a>
            <a class="danger" @click="removeGroup(g)">删除</a>
          </span>
        </div>
        <div v-if="!(groups.groups || []).length" class="rail-empty">还没有分组，可先建一个「轮播图」「商品图」之类的分类</div>
      </div>

      <!-- 文件 -->
      <div class="panel main">
        <div class="toolbar">
          <el-input
            v-model="keyword"
            placeholder="搜索文件名"
            clearable
            style="width: 220px"
            @clear="search"
            @keyup.enter="search"
          />
          <el-button @click="search">搜索</el-button>
          <span class="spacer" />
          <template v-if="selected.length">
            <span class="sel-tip">已选 {{ selected.length }} 项</span>
            <el-button size="small" @click="moveDlg = true">移动分组</el-button>
            <el-button size="small" type="danger" plain @click="remove(selected)">删除</el-button>
            <el-button size="small" text @click="selected = []">取消选择</el-button>
          </template>
        </div>

        <div v-loading="loading" class="grid-wrap">
          <div v-if="list.length" class="grid">
            <div v-for="f in list" :key="f.file_id" class="file" :class="{ sel: selected.includes(f.file_id) }">
              <label class="pick">
                <input type="checkbox" :checked="selected.includes(f.file_id)" @change="toggle(f.file_id)" />
              </label>
              <el-image
                class="thumb"
                :src="f.url"
                :preview-src-list="[f.url]"
                preview-teleported
                hide-on-click-modal
                fit="cover"
              >
                <template #error><div class="thumb-err">加载失败</div></template>
              </el-image>
              <div class="file-name" :title="`${f.name}.${f.ext}`">{{ f.name }}<span class="ext">.{{ f.ext }}</span></div>
              <div class="file-meta">
                {{ f.width && f.height ? `${f.width}×${f.height}` : '—' }} · {{ sizeText(f.size) }}
              </div>
              <div class="file-ops">
                <a @click="openRename(f)">重命名</a>
                <a @click="openMove([f.file_id])">移动</a>
                <a class="danger" @click="remove([f.file_id])">删除</a>
              </div>
            </div>
          </div>
          <div v-else-if="!loading" class="empty-box">
            {{ keyword ? '没有匹配的文件' : '这个分组还没有图片，点右上角「上传图片」添加' }}
          </div>
        </div>

        <div v-if="total > limit" class="pager">
          <el-pagination
            layout="prev, pager, next, total"
            :total="total"
            :page-size="limit"
            :current-page="page"
            @current-change="(p) => { page = p; loadList(); }"
          />
        </div>
      </div>
    </div>

    <!-- 重命名 -->
    <el-dialog v-model="renameDlg" title="重命名" width="460px">
      <el-form label-width="72px">
        <el-form-item label="名称">
          <el-input v-model="renameForm.name" maxlength="60" show-word-limit placeholder="例如：首页轮播-春季" />
        </el-form-item>
      </el-form>
      <div class="dlg-tip">只改展示名，磁盘上的文件名和访问地址不变，已经用到的地方不会裂图。</div>
      <template #footer>
        <el-button @click="renameDlg = false">取消</el-button>
        <el-button type="primary" @click="doRename">保存</el-button>
      </template>
    </el-dialog>

    <!-- 移动分组 -->
    <el-dialog v-model="moveDlg" title="移动到分组" width="460px">
      <el-form label-width="72px">
        <el-form-item label="分组">
          <el-select v-model="moveTo" style="width: 100%">
            <el-option label="未分组" :value="0" />
            <el-option v-for="g in groups.groups || []" :key="g.group_id" :label="g.name" :value="g.group_id" />
          </el-select>
        </el-form-item>
      </el-form>
      <div class="dlg-tip">共 {{ moveIds.length }} 个文件</div>
      <template #footer>
        <el-button @click="moveDlg = false">取消</el-button>
        <el-button type="primary" @click="doMove">移动</el-button>
      </template>
    </el-dialog>

    <!-- 分组 -->
    <el-dialog v-model="groupDlg" :title="groupForm.group_id ? '重命名分组' : '新建分组'" width="460px">
      <el-form label-width="72px">
        <el-form-item label="名称">
          <el-input v-model="groupForm.name" maxlength="30" show-word-limit placeholder="例如：轮播图 / 商品主图 / 活动素材" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="groupDlg = false">取消</el-button>
        <el-button type="primary" @click="saveGroup">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { adminApi } from '../api.js';

const fileEl = ref(null);
const uploading = ref(false);
const loading = ref(false);
const list = ref([]);
const total = ref(0);
const page = ref(1);
const limit = 60;
const keyword = ref('');
const activeGroup = ref('');
const groups = ref({ groups: [], ungrouped: 0, total: 0 });
const selected = ref([]);

const renameDlg = ref(false);
const renameForm = reactive({ file_id: 0, name: '' });
const moveDlg = ref(false);
const moveIds = ref([]);
const moveTo = ref(0);
const groupDlg = ref(false);
const groupForm = reactive({ group_id: 0, name: '' });

const sizeText = (n) => {
  const v = Number(n || 0);
  if (!v) return '—';
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  return `${(v / 1024 / 1024).toFixed(2)} MB`;
};

async function loadGroups() {
  try {
    const r = await adminApi.mediaGroups();
    groups.value = r.data || { groups: [], ungrouped: 0, total: 0 };
  } catch {}
}

async function loadList() {
  loading.value = true;
  try {
    const r = await adminApi.mediaList({
      group_id: activeGroup.value === '' ? undefined : activeGroup.value,
      keyword: keyword.value || undefined,
      page: page.value,
      limit,
    });
    list.value = r.data?.list || [];
    total.value = Number(r.data?.total || 0);
    selected.value = selected.value.filter((id) => list.value.some((f) => f.file_id === id));
  } catch {
    list.value = [];
    total.value = 0;
  } finally {
    loading.value = false;
  }
}

async function load() {
  await Promise.all([loadGroups(), loadList()]);
}

function switchGroup(g) {
  activeGroup.value = g;
  page.value = 1;
  selected.value = [];
  loadList();
}

function search() {
  page.value = 1;
  loadList();
}

function toggle(id) {
  const i = selected.value.indexOf(id);
  if (i >= 0) selected.value.splice(i, 1);
  else selected.value.push(id);
}

async function onPickFiles(e) {
  const files = [...(e.target.files || [])];
  e.target.value = '';
  if (!files.length) return;
  uploading.value = true;
  let ok = 0;
  for (const f of files) {
    try {
      await adminApi.mediaUpload(f, { group_id: activeGroup.value || 0 });
      ok += 1;
    } catch {
      /* 单个失败不打断整批，最后统一报数 */
    }
  }
  uploading.value = false;
  ElMessage[ok === files.length ? 'success' : 'warning'](
    ok === files.length ? `已上传 ${ok} 张` : `上传 ${ok}/${files.length} 张，其余失败`,
  );
  await load();
}

function openRename(f) {
  renameForm.file_id = f.file_id;
  renameForm.name = f.name;
  renameDlg.value = true;
}

async function doRename() {
  const name = String(renameForm.name || '').trim();
  if (!name) return ElMessage.warning('请填写名称');
  try {
    await adminApi.mediaRename({ file_id: renameForm.file_id, name });
    ElMessage.success('已重命名');
    renameDlg.value = false;
    await load();
  } catch {}
}

function openMove(ids) {
  moveIds.value = ids;
  moveTo.value = activeGroup.value === '' ? 0 : activeGroup.value;
  moveDlg.value = true;
}

async function doMove() {
  try {
    await adminApi.mediaMove({ ids: moveIds.value, group_id: moveTo.value });
    ElMessage.success(`已移动 ${moveIds.value.length} 个文件`);
    moveDlg.value = false;
    selected.value = [];
    await load();
  } catch {}
}

function openGroupDlg(g) {
  groupForm.group_id = g?.group_id || 0;
  groupForm.name = g?.name || '';
  groupDlg.value = true;
}

async function saveGroup() {
  const name = String(groupForm.name || '').trim();
  if (!name) return ElMessage.warning('请填写分组名称');
  try {
    await adminApi.mediaSaveGroup({ group_id: groupForm.group_id, name });
    ElMessage.success(groupForm.group_id ? '已重命名' : '已创建');
    groupDlg.value = false;
    await load();
  } catch {}
}

async function removeGroup(g) {
  try {
    await ElMessageBox.confirm(
      `删除分组「${g.name}」？里面的 ${g.count} 个文件不会删除，会退回「未分组」。`,
      '删除分组',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' },
    );
  } catch {
    return;
  }
  try {
    const r = await adminApi.mediaRemoveGroup({ group_id: g.group_id });
    ElMessage.success(r.msg || '已删除');
    if (activeGroup.value === g.group_id) activeGroup.value = '';
    await load();
  } catch {}
}

async function remove(ids) {
  const items = list.value.filter((f) => ids.includes(f.file_id));
  const label = items.length === 1 ? `「${items[0].name}」` : `${items.length} 个文件`;
  try {
    await ElMessageBox.confirm(`删除 ${label}？删除后磁盘文件也会一起清掉，无法恢复。`, '删除文件', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消',
    });
  } catch {
    return;
  }
  try {
    const r = await adminApi.mediaRemove({ ids });
    const skipped = r.data?.skipped || [];
    if (skipped.length) {
      ElMessage.warning(r.msg || '部分文件未删除');
      const rows = skipped
        .map((s) => `<li><b>${escapeHtml(s.name)}</b> — ${s.usages.map(escapeHtml).join('、')}</li>`)
        .join('');
      ElMessageBox.alert(
        `<p>下面这些图片还在被使用，为避免前台裂图没有删除。请先到对应页面换掉图片再回来删：</p><ul class="skip-list">${rows}</ul>`,
        '以下文件仍在使用',
        { dangerouslyUseHTMLString: true, confirmButtonText: '知道了' },
      );
    } else {
      ElMessage.success(r.msg || '已删除');
    }
    selected.value = [];
    await load();
  } catch {}
}

const escapeHtml = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

onMounted(load);
</script>

<style scoped>
.head-actions { display: flex; gap: 9px; align-items: center; }

.layout { display: grid; grid-template-columns: 226px minmax(0, 1fr); gap: 14px; align-items: start; }

/* ---- 左侧分组 ---- */
.rail { padding: 10px; position: sticky; top: 10px; }
.rail-total {
  display: flex; align-items: baseline; justify-content: space-between;
  padding: 8px 10px 12px; font-size: 12px; color: #8c93a0;
}
.rail-total b { font-size: 20px; color: #22252b; font-variant-numeric: tabular-nums; }
.rail-title {
  font-size: 11.5px; color: #a8adb7; padding: 14px 10px 6px;
  border-top: 1px solid #f2f4f7; margin-top: 6px;
}
.rail-item {
  display: flex; align-items: center; gap: 8px;
  padding: 8px 10px; border-radius: 9px; cursor: pointer;
  font-size: 13px; color: #4f5662; position: relative;
}
.rail-item:hover { background: #fafbfc; }
.rail-item.on { background: #fff1ee; color: #d14328; font-weight: 600; }
.rail-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rail-item em { font-style: normal; font-size: 11.5px; color: #a8adb7; font-variant-numeric: tabular-nums; }
.rail-item.on em { color: #e0796a; }
.rail-ops { display: none; gap: 6px; position: absolute; right: 8px; background: inherit; padding-left: 6px; }
.rail-item:hover .rail-ops { display: flex; }
.rail-ops a { font-size: 11.5px; color: #8c93a0; cursor: pointer; }
.rail-ops a:hover { color: #ff513a; }
.rail-ops a.danger:hover { color: #d14328; }
.rail-item:hover em { visibility: hidden; }
.rail-empty { font-size: 11.5px; color: #a8adb7; line-height: 1.6; padding: 8px 10px; }

/* ---- 右侧 ---- */
.main { min-height: 420px; }
.toolbar { display: flex; align-items: center; gap: 10px; margin-bottom: 14px; flex-wrap: wrap; }
.toolbar .spacer { flex: 1; }
.sel-tip { font-size: 12px; color: #8c93a0; }

.grid-wrap { min-height: 300px; }
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(148px, 1fr));
  gap: 12px;
}
.file {
  position: relative;
  border: 1px solid #eceff3;
  border-radius: 12px;
  padding: 8px;
  background: #fff;
  transition: border-color 0.16s, box-shadow 0.16s;
}
.file:hover { border-color: #ffcdc5; box-shadow: 0 6px 16px rgba(255, 81, 58, 0.08); }
.file.sel { border-color: #ff513a; box-shadow: 0 0 0 2px rgba(255, 81, 58, 0.12); }
.pick { position: absolute; top: 12px; left: 12px; z-index: 2; }
.pick input { width: 15px; height: 15px; accent-color: #ff513a; cursor: pointer; }

.thumb {
  width: 100%;
  height: 108px;
  border-radius: 8px;
  background: #f7f8fa;
  cursor: zoom-in;
  display: block;
}
.thumb-err { display: flex; height: 100%; align-items: center; justify-content: center; font-size: 11.5px; color: #a8adb7; }
.file-name {
  font-size: 12.5px; margin-top: 8px; font-weight: 550;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.file-name .ext { color: #a8adb7; font-weight: 400; }
.file-meta { font-size: 11px; color: #a8adb7; margin-top: 3px; font-variant-numeric: tabular-nums; }
.file-ops { display: flex; gap: 10px; margin-top: 7px; opacity: 0; transition: opacity 0.16s; }
.file:hover .file-ops, .file.sel .file-ops { opacity: 1; }
.file-ops a { font-size: 11.5px; color: #8c93a0; cursor: pointer; }
.file-ops a:hover { color: #ff513a; }
.file-ops a.danger:hover { color: #d14328; }

.pager { display: flex; justify-content: flex-end; margin-top: 16px; }
.dlg-tip { font-size: 12px; color: #8c93a0; line-height: 1.65; }

:deep(.skip-list) { margin: 8px 0 0; padding-left: 18px; font-size: 12.5px; line-height: 1.9; color: #626a76; }

@media (max-width: 960px) {
  .layout { grid-template-columns: 1fr; }
  .rail { position: static; }
}
</style>
