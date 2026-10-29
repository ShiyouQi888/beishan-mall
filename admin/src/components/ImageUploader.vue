<template>
  <SharedImageUploader v-bind="$attrs" :cropper-class="Cropper" />
</template>

<script setup>
defineOptions({ inheritAttrs: false });
import Cropper from 'cropperjs';
import 'cropperjs/dist/cropper.css';
import SharedImageUploader from '../../../shared/ImageUploader.vue';
</script>
