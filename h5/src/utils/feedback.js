import {
  showConfirmDialog as vantShowConfirmDialog,
  showDialog as vantShowDialog,
  showToast as vantShowToast,
} from 'vant';

function messageText(message) {
  return String(message ?? '').trim();
}

function toneFor(message) {
  const text = messageText(message);
  if (/成功|已复制|已删除|已保存|已确认|已取消|已提交|申请已|兑换成功|已退出|已完成/.test(text)) return 'success';
  if (/失败|错误|异常|无效|不足|网络|不支持|不存在|获取失败|已关闭/.test(text)) return 'error';
  if (/请输入|请先|请选择|请上传|请填写|暂无|不能|需要|未加载|不正确|未开放/.test(text)) return 'warning';
  return 'info';
}

export function showToast(input, overrides = {}) {
  const options = typeof input === 'string' || typeof input === 'number'
    ? { message: input, ...overrides }
    : { ...(input || {}), ...overrides };
  const tone = options.tone || (options.type === 'success' ? 'success' : options.type === 'fail' ? 'error' : toneFor(options.message));
  delete options.tone;
  return vantShowToast({
    ...options,
    type: options.type || 'text',
    position: options.position || 'middle',
    duration: options.duration ?? 2200,
    zIndex: options.zIndex ?? 4000,
    className: ['app-toast', `app-toast--${tone}`, options.className].filter(Boolean),
  });
}

function dialogOptions(options, variant, defaults = {}) {
  const customClass = options?.className;
  return {
    messageAlign: 'center',
    ...defaults,
    ...(options || {}),
    className: ['app-dialog', `app-dialog--${variant}`, customClass].filter(Boolean),
  };
}

export function showConfirmDialog(options = {}) {
  return vantShowConfirmDialog(dialogOptions(options, 'confirm', {
    cancelButtonText: '取消',
    confirmButtonText: '确认',
  }));
}

/**
 * 危险操作的确认弹窗（取消订单、删除等不可撤销的动作）。
 *
 * 和普通确认的区别：图标是红色感叹号而不是问号、主按钮是危险色，
 * 目的是让用户在按下去之前意识到「这一步撤不回来」。
 * 默认按钮文案也改成可执行的动作（确认取消 / 再想想），而不是抽象的「确定/取消」。
 */
export function showDangerConfirm(options = {}) {
  const opts = {
    cancelButtonText: '再想想',
    confirmButtonText: '确认取消',
    ...(options || {}),
  };
  const customClass = opts.className;
  return vantShowConfirmDialog({
    ...opts,
    className: ['app-dialog', 'app-dialog--danger', customClass].filter(Boolean),
  });
}

export function showDialog(options = {}) {
  return vantShowDialog(dialogOptions(options, 'alert', {
    confirmButtonText: '我知道了',
  }));
}
