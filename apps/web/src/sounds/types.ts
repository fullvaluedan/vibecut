/** Marker the /api/sounds/search route sends when FREESOUND_API_KEY is unset or still the .env.example placeholder. */
export const FREESOUND_NOT_CONFIGURED_ERROR = "freesound_not_configured";

export interface SoundEffect {
	id: number;
	name: string;
	description: string;
	url: string;
	previewUrl?: string;
	downloadUrl?: string;
	duration: number;
	filesize: number;
	type: string;
	channels: number;
	bitrate: number;
	bitdepth: number;
	samplerate: number;
	username: string;
	tags: string[];
	license: string;
	created: string;
	downloads: number;
	rating: number;
	ratingCount: number;
}

export interface SavedSound {
	id: number; // freesound id
	name: string;
	username: string;
	previewUrl?: string;
	downloadUrl?: string;
	duration: number;
	tags: string[];
	license: string;
	savedAt: string; // iso date string
}

export interface SavedSoundsData {
	sounds: SavedSound[];
	lastModified: string;
}
