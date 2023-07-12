import { Client } from 'discord-rpc';
import throttle from 'lodash-es/throttle';
import { commands, ExtensionContext, StatusBarAlignment, StatusBarItem, window, workspace, debug } from 'vscode';

import { activityService } from './activity';
import { CLIENT_ID, CONFIG_KEYS } from './constants';
import { log, LogLevel } from './logger';
import { getConfig, getGit } from './util';

class DiscordPresence {
	private statusBarIcon: StatusBarItem;
	private rpc: Client;
	private readonly config: Record<string, any>;
	private state: Record<string, any>;
	private idle: NodeJS.Timeout | undefined;
	private listeners: { dispose: () => void }[];

	constructor() {
		this.statusBarIcon = window.createStatusBarItem(StatusBarAlignment.Left);
		this.statusBarIcon.text = '$(pulse) Connecting to Discord...';
		this.rpc = new Client({ transport: 'ipc' });
		this.config = getConfig();
		this.state = {};
		this.idle = undefined;
		this.listeners = [];
	}

	public async activate(context: ExtensionContext) {
		log(LogLevel.Info, 'Discord Presence activated');

		let isWorkspaceExcluded = false;
		for (const pattern of this.config[CONFIG_KEYS.WorkspaceExcludePatterns]) {
			const regex = new RegExp(pattern as string);
			const folders = workspace.workspaceFolders;
			if (!folders) break;
			if (folders.some((folder) => regex.test(folder.uri.fsPath))) {
				isWorkspaceExcluded = true;
				break;
			}
		}

		const enable = async (update = true) => {
			if (update) {
				try {
					await this.config.update('enabled', true);
				} catch {}
			}
			log(LogLevel.Info, 'Enable: Cleaning up old listeners');
			this.cleanUp();
			this.statusBarIcon.text = '$(pulse) Connecting to Discord...';
			this.statusBarIcon.show();
			log(LogLevel.Info, 'Enable: Attempting to recreate login');
			await this.login();
		};

		const disable = async (update = true) => {
			if (update) {
				try {
					await this.config.update('enabled', false);
				} catch (error) {
					// Handle the error, if needed
				}
			}
			log(LogLevel.Info, 'Disable: Cleaning up old listeners');
			this.cleanUp();
			void this.rpc.destroy();
			log(LogLevel.Info, 'Disable: Destroyed the rpc instance');
			this.statusBarIcon.hide();
		};

		const enabler = commands.registerCommand('discord.enable', async () => {
			await disable();
			await enable();
			await window.showInformationMessage('Enabled Discord Presence for this workspace');
		});

		const disabler = commands.registerCommand('discord.disable', async () => {
			await disable();
			await window.showInformationMessage('Disabled Discord Presence for this workspace');
		});

		const reconnecter = commands.registerCommand('discord.reconnect', async () => {
			await disable(false);
			await enable(false);
		});

		const disconnect = commands.registerCommand('discord.disconnect', async () => {
			await disable(false);
			this.statusBarIcon.text = '$(pulse) Reconnect to Discord';
			this.statusBarIcon.command = 'discord.reconnect';
			this.statusBarIcon.show();
		});

		context.subscriptions.push(enabler, disabler, reconnecter, disconnect);

		if (!isWorkspaceExcluded && this.config[CONFIG_KEYS.Enabled]) {
			this.statusBarIcon.show();
			await this.login();
		}

		window.onDidChangeWindowState(async (windowState) => {
			if (this.config[CONFIG_KEYS.IdleTimeout] !== 0) {
				if (windowState.focused) {
					if (this.idle) {
						clearTimeout(this.idle);
					}

					await this.sendActivity();
				} else {
					this.idle = setTimeout(() => {
						const clearActivity = async () => {
							this.state = {};
							await this.rpc.clearActivity();
						};

						void clearActivity();
					}, this.config[CONFIG_KEYS.IdleTimeout] * 1000);
				}
			}
		});

		await getGit();
	}

	public deactivate() {
		this.cleanUp();
		return this.rpc.destroy();
	}

	private async sendActivity() {
		this.state = {
			...(await activityService.getActivity(this.state)),
		};
		return this.rpc.setActivity(this.state);
	}

	private async login() {
		log(LogLevel.Info, 'Creating discord-rpc client');
		this.rpc = new Client({ transport: 'ipc' });

		this.rpc.on('ready', () => {
			log(LogLevel.Info, 'Successfully connected to Discord');
			this.cleanUp();

			this.statusBarIcon.text = '$(globe) Connected to Discord';
			this.statusBarIcon.tooltip = 'Connected to Discord';

			void this.sendActivity();
			const onChangeActiveTextEditor = window.onDidChangeActiveTextEditor(() => this.sendActivity());
			const onChangeTextDocument = workspace.onDidChangeTextDocument(throttle(() => this.sendActivity(), 2000));
			const onStartDebugSession = debug.onDidStartDebugSession(() => this.sendActivity());
			const onTerminateDebugSession = debug.onDidTerminateDebugSession(() => this.sendActivity());

			this.listeners.push(onChangeActiveTextEditor, onChangeTextDocument, onStartDebugSession, onTerminateDebugSession);
		});

		this.rpc.on('disconnected', () => {
			this.cleanUp();
			void this.rpc.destroy();
			this.statusBarIcon.text = '$(pulse) Reconnect to Discord';
			this.statusBarIcon.command = 'discord.reconnect';
		});

		try {
			await this.rpc.login({ clientId: CLIENT_ID });
		} catch (error) {
			const err = error as Error;
			log(LogLevel.Error, `Encountered the following error while trying to login:\n${error as string}`);
			this.cleanUp();
			void this.rpc.destroy();
			if (!this.config[CONFIG_KEYS.SuppressNotifications]) {
				if (err.message.includes('ENOENT')) {
					void window.showErrorMessage('No Discord client detected');
				} else {
					void window.showErrorMessage(`Couldn't connect to Discord via RPC: ${error as string}`);
				}
			}
			this.statusBarIcon.text = '$(pulse) Reconnect to Discord';
			this.statusBarIcon.command = 'discord.reconnect';
		}
	}

	private cleanUp() {
		this.listeners.forEach((listener) => listener.dispose());
		this.listeners.length = 0;
	}
}

const discordPresence = new DiscordPresence();
export function activate(context: ExtensionContext) {
	return discordPresence.activate(context);
}

export function deactivate() {
	return discordPresence.deactivate();
}
