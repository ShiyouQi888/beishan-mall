<template>
  <SharedImageEditor v-bind="$attrs" :cropper-class="Cropper" />
</template>

<script setup>
defineOptions({ inheritAttrs: false });
import Cropper from 'cropperjs';
import 'cropperjs/dist/cropper.css';
import SharedImageEditor from '../../../shared/ImageEditor.vue';
</script>
