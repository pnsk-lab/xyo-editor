export type ScratchCostumeLibraryItem = {
    name: string;
    md5ext: string;
    dataFormat: 'svg' | 'png';
    tags: string[];
    rotationCenterX?: number;
    rotationCenterY?: number;
    bitmapResolution?: number;
};
export type ScratchSoundLibraryItem = {
    name: string;
    md5ext: string;
    dataFormat: 'wav' | 'mp3';
    tags: string[];
    rate: number;
    sampleCount: number;
};
export type ScratchSpriteLibraryItem = {
    name: string;
    tags: string[];
    costumes: ScratchCostumeLibraryItem[];
    sounds: ScratchSoundLibraryItem[];
};
export declare const scratchSpriteLibrary: ScratchSpriteLibraryItem[];
export declare const scratchCostumeLibrary: ScratchCostumeLibraryItem[];
export declare const scratchSoundLibrary: ScratchSoundLibraryItem[];
