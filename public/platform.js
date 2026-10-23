// Where the app is running: 'ios' or 'android' inside the phone app, 'web' in a browser.
// Inside the phone app, Capacitor's bridge puts `Capacitor` on window, so native
// plugins can be called without bundling @capacitor/core.
const cap = globalThis.Capacitor;

export const isNative = Boolean(cap?.isNativePlatform?.());
export const platform = isNative ? cap.getPlatform() : 'web';

export function native(plugin, method, options = {}) {
  if (!isNative) return Promise.reject(new Error('Only available in the phone app.'));
  return cap.nativePromise(plugin, method, options);
}

if (isNative) document.documentElement.classList.add('native', `native-${platform}`);

export function onNative(plugin, eventName, callback) {
  if (isNative) cap.nativeCallback(plugin, 'addListener', { eventName }, callback);
}
