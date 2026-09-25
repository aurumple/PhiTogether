// PZv1
export interface SongMeta<fileType = string> {
    id: string | number;
    composer: string;
    illustrator: string;
    name: string;
    song: fileType;
    illustration: fileType;
    edition?: string | null;
    bpm?: number | null;
    duration?: string | null;
    preview_start?: string | null;
    preview_end?: string | null;
    previewStart?: string | null;
    previewEnd?: string | null;
    charts?: ChartMeta[] | null;
    isFromURL?: boolean;
    origin?: SongMeta;
}
export interface ChartMeta<songType = string | SongMeta, fileType = string> {
    id: string | number;
    level: string;
    difficulty: number;
    chart: fileType;
    ranked?: boolean | null;
    charter: string;
    notes?: number | null;
    song: songType;
    assets?: string;
    assetsNum?: number | null;
    for?: string;
    like_count?: number | null;
    isFromURL?: boolean;
    origin?: ChartMeta;
}
