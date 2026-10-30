import { ref } from 'vue';
import type { GitState } from '@shared/types';

/** The Git section's state (repositories, shared accounts, the clone running), kept current while it is open. */
export const gitState = ref<GitState | null>(null);
/** Open the Clone dialog with these values (an account's repository, or empty for a URL). */
export const cloneRequest = ref<{ url: string; name: string; branch: string } | null>(null);
