/**
 * Ambient types for the globals the PAGE fixture in browser.e2e.mts installs
 * in the browser (see the PAGE template). They are only read from inside
 * page.evaluate / waitForFunction callbacks, which run in the browser realm.
 */
declare global {
  interface Window {
    /** sidebarRight.openResource pushes [address, options] here. */
    __opened: [string, { kind?: string }][];
    /** sidebarRightTabs.register pushes the tab-type descriptors here. */
    __tabTypes: { kind?: string; priority?: string; keepMounted?: boolean; patterns?: unknown }[];
    /** sidebarRight.registerCloseHandler stores handlers by tab kind here. */
    __closeHandlers: Record<string, (sessionId: string, tab: { id: string; title: string }) => void>;
  }
}

export {};
