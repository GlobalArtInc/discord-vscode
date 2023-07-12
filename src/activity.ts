import { basename, parse, sep } from 'path';
import { debug, env, Selection, TextDocument, window, workspace } from 'vscode';

import {
	CONFIG_KEYS,
	DEBUG_IMAGE_KEY,
	EMPTY,
	FAKE_EMPTY,
	FILE_SIZES,
	IDLE_IMAGE_KEY,
	REPLACE_KEYS,
	UNKNOWN_GIT_BRANCH,
	UNKNOWN_GIT_REPO_NAME,
	VSCODE_IMAGE_KEY,
	VSCODE_INSIDERS_IMAGE_KEY,
	VSCODE_KUBERNETES_IMAGE_KEY,
} from './constants';
import { log, LogLevel } from './logger';
import { getConfig, getGit, resolveFileIcon, toLower, toTitle, toUpper } from './util';

interface ActivityPayload {
	details?: string | undefined;
	state?: string | undefined;
	startTimestamp?: number | null | undefined;
	largeImageKey?: string | undefined;
	largeImageText?: string | undefined;
	smallImageKey?: string | undefined;
	smallImageText?: string | undefined;
	partyId?: string | undefined;
	partySize?: number | undefined;
	partyMax?: number | undefined;
	matchSecret?: string | undefined;
	joinSecret?: string | undefined;
	spectateSecret?: string | undefined;
	buttons?: { label: string; url: string }[] | undefined;
	instance?: boolean | undefined;
}

class ActivityService {
	private readonly config: Record<string, string>;
	private readonly appName: string;
	private readonly remoteName: string | undefined;
	private readonly isK8s: boolean;
	private readonly defaultSmallImageKey: string;
	private readonly defaultSmallImageText: string;
	private readonly defaultLargeImageText: string;

	constructor() {
		this.config = getConfig();
		this.appName = env.appName;
		this.remoteName = env.remoteName;
		this.isK8s = this.remoteName === 'k8s-container';
		this.defaultSmallImageKey = this.isK8s
			? VSCODE_KUBERNETES_IMAGE_KEY
			: debug.activeDebugSession
			? DEBUG_IMAGE_KEY
			: this.appName.includes('Insiders')
			? VSCODE_INSIDERS_IMAGE_KEY
			: VSCODE_IMAGE_KEY;
		this.defaultSmallImageText = this.config[CONFIG_KEYS.SmallImage].replace(REPLACE_KEYS.AppName, this.appName);
		this.defaultLargeImageText = this.config[CONFIG_KEYS.LargeImageIdling];
	}

	async getActivity(previous: ActivityPayload = {}): Promise<ActivityPayload> {
		const swapBigAndSmallImage = this.config[CONFIG_KEYS.SwapBigAndSmallImage];
		const removeDetails = this.config[CONFIG_KEYS.RemoveDetails];
		const removeLowerDetails = this.config[CONFIG_KEYS.RemoveLowerDetails];
		const removeRemoteRepository = this.config[CONFIG_KEYS.RemoveRemoteRepository];

		const git = await getGit();

		let state: ActivityPayload = {
			details: removeDetails
				? undefined
				: await this.getDetails(CONFIG_KEYS.DetailsIdling, CONFIG_KEYS.DetailsEditing, CONFIG_KEYS.DetailsDebugging),
			startTimestamp: this.config[CONFIG_KEYS.RemoveTimestamp] ? undefined : previous.startTimestamp ?? Date.now(),
			largeImageKey: IDLE_IMAGE_KEY,
			largeImageText: this.defaultLargeImageText,
			smallImageKey: this.defaultSmallImageKey,
			smallImageText: this.defaultSmallImageText,
		};

		if (swapBigAndSmallImage) {
			state = {
				...state,
				largeImageKey: this.defaultSmallImageKey,
				largeImageText: this.defaultSmallImageText,
				smallImageKey: IDLE_IMAGE_KEY,
				smallImageText: this.defaultLargeImageText,
			};
		}

		if (!removeRemoteRepository && git?.repositories.length) {
			const repo = git.repositories.find((repo) => repo.ui.selected)?.state.remotes[0]?.fetchUrl;

			if (repo) {
				const formattedRepo = this.formatRepositoryUrl(repo);
				state = {
					...state,
					buttons: [{ label: 'View Repository', url: formattedRepo }],
				};
			}
		}

		if (window.activeTextEditor) {
			const largeImageKey = resolveFileIcon(window.activeTextEditor.document);
			const largeImageText = this.formatLargeImageText(this.config[CONFIG_KEYS.LargeImage], largeImageKey);

			state = {
				...state,
				details: removeDetails
					? undefined
					: await this.getDetails(CONFIG_KEYS.DetailsIdling, CONFIG_KEYS.DetailsEditing, CONFIG_KEYS.DetailsDebugging),
				state: removeLowerDetails
					? undefined
					: await this.getDetails(
							CONFIG_KEYS.LowerDetailsIdling,
							CONFIG_KEYS.LowerDetailsEditing,
							CONFIG_KEYS.LowerDetailsDebugging,
					  ),
			};

			if (swapBigAndSmallImage) {
				state = {
					...state,
					smallImageKey: largeImageKey,
					smallImageText: largeImageText,
				};
			} else {
				state = {
					...state,
					largeImageKey,
					largeImageText,
				};
			}

			log(LogLevel.Trace, `VSCode language id: ${window.activeTextEditor.document.languageId}`);
		}

		return state;
	}

	private async getDetails(idling: CONFIG_KEYS, editing: CONFIG_KEYS, debugging: CONFIG_KEYS): Promise<string> {
		let raw = this.config[idling].replace(REPLACE_KEYS.Empty, FAKE_EMPTY);

		if (window.activeTextEditor) {
			const fileName = basename(window.activeTextEditor.document.fileName);
			const { dir } = parse(window.activeTextEditor.document.fileName);
			const split = dir.split(sep);
			const dirName = split[split.length - 1];

			const noWorkspaceFound = this.config[CONFIG_KEYS.LowerDetailsNoWorkspaceFound].replace(
				REPLACE_KEYS.Empty,
				FAKE_EMPTY,
			);
			const workspaceFolder = workspace.getWorkspaceFolder(window.activeTextEditor.document.uri);
			const workspaceFolderName = workspaceFolder?.name ?? noWorkspaceFound;
			const workspaceName = workspace.name?.replace(REPLACE_KEYS.VSCodeWorkspace, EMPTY) ?? workspaceFolderName;
			const workspaceAndFolder = `${workspaceName}${
				workspaceFolderName === FAKE_EMPTY ? '' : ` - ${workspaceFolderName}`
			}`;

			const fileIcon = resolveFileIcon(window.activeTextEditor.document);

			if (debug.activeDebugSession) {
				raw = this.config[debugging];
			} else {
				raw = this.config[editing];
			}

			if (workspaceFolder) {
				const { name } = workspaceFolder;
				const relativePath = workspace.asRelativePath(window.activeTextEditor.document.fileName).split(sep);
				relativePath.splice(-1, 1);
				raw = raw.replace(REPLACE_KEYS.FullDirName, `${name}${sep}${relativePath.join(sep)}`);
			}

			try {
				raw = await this.getFileDetails(raw, window.activeTextEditor.document, window.activeTextEditor.selection);
			} catch (error) {
				log(LogLevel.Error, `Failed to generate file details: ${error as string}`);
			}
			raw = raw
				.replace(REPLACE_KEYS.FileName, fileName)
				.replace(REPLACE_KEYS.DirName, dirName)
				.replace(REPLACE_KEYS.Workspace, workspaceName)
				.replace(REPLACE_KEYS.WorkspaceFolder, workspaceFolderName)
				.replace(REPLACE_KEYS.WorkspaceAndFolder, workspaceAndFolder)
				.replace(REPLACE_KEYS.LanguageLowerCase, toLower(fileIcon))
				.replace(REPLACE_KEYS.LanguageTitleCase, toTitle(fileIcon))
				.replace(REPLACE_KEYS.LanguageUpperCase, toUpper(fileIcon));
		}

		return raw.substring(0, 128);
	}

	private async getFileDetails(raw: string, document: TextDocument, selection: Selection): Promise<string> {
		let updatedRaw = raw.slice();

		if (updatedRaw.includes(REPLACE_KEYS.TotalLines)) {
			updatedRaw = updatedRaw.replace(REPLACE_KEYS.TotalLines, document.lineCount.toLocaleString());
		}

		if (updatedRaw.includes(REPLACE_KEYS.CurrentLine)) {
			updatedRaw = updatedRaw.replace(REPLACE_KEYS.CurrentLine, (selection.active.line + 1).toLocaleString());
		}

		if (updatedRaw.includes(REPLACE_KEYS.CurrentColumn)) {
			updatedRaw = updatedRaw.replace(REPLACE_KEYS.CurrentColumn, (selection.active.character + 1).toLocaleString());
		}

		if (updatedRaw.includes(REPLACE_KEYS.FileSize)) {
			let currentDivision = 0;
			let size: number;
			try {
				({ size } = await workspace.fs.stat(document.uri));
			} catch {
				size = document.getText().length;
			}
			const originalSize = size;
			if (originalSize > 1000) {
				size /= 1000;
				currentDivision++;
				while (size > 1000) {
					currentDivision++;
					size /= 1000;
				}
			}

			updatedRaw = updatedRaw.replace(
				REPLACE_KEYS.FileSize,
				`${originalSize > 1000 ? size.toFixed(2) : size}${FILE_SIZES[currentDivision]}`,
			);
		}

		const git = await getGit();

		if (updatedRaw.includes(REPLACE_KEYS.GitBranch)) {
			if (git?.repositories.length) {
				updatedRaw = updatedRaw.replace(
					REPLACE_KEYS.GitBranch,
					git.repositories.find((repo) => repo.ui.selected)?.state.HEAD?.name ?? FAKE_EMPTY,
				);
			} else {
				updatedRaw = updatedRaw.replace(REPLACE_KEYS.GitBranch, UNKNOWN_GIT_BRANCH);
			}
		}

		if (updatedRaw.includes(REPLACE_KEYS.GitRepoName)) {
			if (git?.repositories.length) {
				updatedRaw = updatedRaw.replace(
					REPLACE_KEYS.GitRepoName,
					git.repositories
						.find((repo) => repo.ui.selected)
						?.state.remotes[0].fetchUrl?.split('/')[1]
						.replace('.git', '') ?? FAKE_EMPTY,
				);
			} else {
				updatedRaw = updatedRaw.replace(REPLACE_KEYS.GitRepoName, UNKNOWN_GIT_REPO_NAME);
			}
		}

		return updatedRaw;
	}

	private formatRepositoryUrl(url: string): string {
		if (url.startsWith('git@') || url.startsWith('ssh://')) {
			return url.replace('ssh://', '').replace(':', '/').replace('git@', 'https://').replace('.git', '');
		}
		return url.replace(/(https:\/\/)([^@]*)@(.*?$)/, '$1$3').replace('.git', '');
	}

	private formatLargeImageText(template: string, languageKey: string): string {
		return template
			.replace(REPLACE_KEYS.LanguageLowerCase, toLower(languageKey))
			.replace(REPLACE_KEYS.LanguageTitleCase, toTitle(languageKey))
			.replace(REPLACE_KEYS.LanguageUpperCase, toUpper(languageKey))
			.padEnd(2, FAKE_EMPTY);
	}
}

export const activityService = new ActivityService();
