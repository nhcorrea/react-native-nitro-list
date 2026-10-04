type UiThreadModule = typeof import('./uiThread');

let uiThreadModule: UiThreadModule | null = null;

export function loadUiThread(): UiThreadModule {
  if (uiThreadModule == null) uiThreadModule = require('./uiThread') as UiThreadModule;
  return uiThreadModule;
}
