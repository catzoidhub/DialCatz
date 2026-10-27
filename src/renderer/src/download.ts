import { downloadLink } from '@shared/platform';
import { notify } from './state';

/**
 * "Get DevCatz / DBCatz": the Catzoid site's download for THIS computer (Windows installer, Apple-silicon or Intel
 * DMG — Catzoid #78), worked out when clicked from the app's real platform and processor, never a guess made before
 * that is known. Without a build for this computer it says so instead of opening another platform's file.
 */
export async function openDownload(app: 'devcatz' | 'dbcatz', name: string): Promise<boolean> {
  const api = window.dialcatz;
  const info = await api.appInfo();
  const url = downloadLink(info.site, app, info.platform, info.arch);
  if (!url) {
    notify('error', `There is no ${name} for this computer yet`);
    return false;
  }
  await api.openUrl(url);
  return true;
}
