// Document Picture-in-Picture isn't in TypeScript's DOM lib yet.
declare global {
	interface Window {
		documentPictureInPicture?: {
			requestWindow(options?: {
				width?: number;
				height?: number;
				disallowReturnToOpener?: boolean;
				preferInitialWindowPlacement?: boolean;
			}): Promise<Window>;
		};
	}
}

export {};
