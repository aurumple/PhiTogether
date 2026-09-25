export interface TmodifiedWindow extends Window {
    nativeApi?: TnativeApi;
    hook: any;
}

interface TnativeApi {
    antiAddiction_enterGame(): void;
    antiAddiction_leaveGame(): void;
    antiAddiction_enabled(): boolean;
    saveAs(data: string, filename: string): void;
}

export interface TmodifiedMeta extends ImportMeta {
    env: any;
}
