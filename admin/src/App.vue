<template>
  <!-- 组件库改成按需引入后，没有 app.use(ElementPlus) 的全局 locale 了，
       用 config-provider 包一层，分页器、日期选择这些内置文案仍是中文 -->
  <el-config-provider :locale="zhCn">
    <router-view />
  </el-config-provider>
</template>

<script setup>
import zhCn from 'element-plus/es/locale/lang/zh-cn';
</script>
