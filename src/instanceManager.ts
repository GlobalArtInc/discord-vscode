import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { env, window, workspace } from 'vscode';
import { CONFIG_KEYS } from './constants';
import { log, LogLevel } from './logger';
import { getConfig } from './util';

export interface InstanceInfo {
	id: string;
	workspaceName: string;
	timestamp: number;
	pid: number;
}

class InstanceManager {
	private instanceId: string;
	private instanceInfo: InstanceInfo;
	private instancesDir: string;
	private instanceFile: string;
	private cleanupInterval: NodeJS.Timeout | undefined;

	constructor() {
		this.instanceId = this.generateInstanceId();
		this.instancesDir = join(tmpdir(), 'discord-vscode-instances');
		this.instanceFile = join(this.instancesDir, `${this.instanceId}.json`);

		this.instanceInfo = {
			id: this.instanceId,
			workspaceName: this.getWorkspaceName(),
			timestamp: Date.now(),
			pid: process.pid,
		};

		this.ensureInstancesDir();
		this.registerInstance();
		this.startCleanupTimer();
	}

	private generateInstanceId(): string {
		const timestamp = Date.now();
		const random = Math.random().toString(36).substring(2, 8);
		return `${env.sessionId}-${timestamp}-${random}`;
	}

	private getWorkspaceName(): string {
		if (workspace.workspaceFolders && workspace.workspaceFolders.length > 0) {
			return workspace.workspaceFolders[0].name;
		}
		if (workspace.name) {
			return workspace.name;
		}
		return 'Untitled Workspace';
	}

	private ensureInstancesDir(): void {
		try {
			if (!existsSync(this.instancesDir)) {
				mkdirSync(this.instancesDir, { recursive: true });
			}
		} catch (error) {
			log(LogLevel.Error, `Failed to create instances directory: ${error}`);
		}
	}

	private registerInstance(): void {
		try {
			writeFileSync(this.instanceFile, JSON.stringify(this.instanceInfo, null, 2));
			log(LogLevel.Debug, `Registered instance ${this.instanceId}`);
		} catch (error) {
			log(LogLevel.Error, `Failed to register instance: ${error}`);
		}
	}

	private startCleanupTimer(): void {
		this.cleanupInterval = setInterval(() => {
			this.cleanupStaleInstances();
			this.updateInstance();
		}, 30000);
	}

	private cleanupStaleInstances(): void {
		try {
			if (!existsSync(this.instancesDir)) return;

			const files = readdirSync(this.instancesDir);
			const now = Date.now();
			const staleThreshold = 60000;

			for (const file of files) {
				if (!file.endsWith('.json')) continue;

				const filePath = join(this.instancesDir, file);
				try {
					const stats = statSync(filePath);
					if (now - stats.mtime.getTime() > staleThreshold) {
						unlinkSync(filePath);
						log(LogLevel.Debug, `Cleaned up stale instance file: ${file}`);
					}
				} catch (error) {
					log(LogLevel.Debug, `Failed to check/clean instance file ${file}: ${error}`);
				}
			}
		} catch (error) {
			log(LogLevel.Error, `Failed to cleanup stale instances: ${error}`);
		}
	}

	private updateInstance(): void {
		this.instanceInfo.timestamp = Date.now();
		this.registerInstance();
	}

	getInstanceId(): string {
		return this.instanceId;
	}

	getInstanceInfo(): InstanceInfo {
		return { ...this.instanceInfo };
	}

	updateWorkspaceName(): void {
		this.instanceInfo.workspaceName = this.getWorkspaceName();
		this.instanceInfo.timestamp = Date.now();
		this.registerInstance();
	}

	isMultiInstanceModeEnabled(): boolean {
		const config = getConfig();
		return config[CONFIG_KEYS.MultiInstanceMode] as boolean;
	}

	async isActiveInstance(): Promise<boolean> {
		if (!this.isMultiInstanceModeEnabled()) {
			return true;
		}

		const config = getConfig();
		const activeInstanceId = config[CONFIG_KEYS.ActiveInstanceId] as string;

		if (!activeInstanceId) {
			await this.setAsActiveInstance();
			return true;
		}

		return activeInstanceId === this.instanceId;
	}

	async setAsActiveInstance(): Promise<void> {
		const config = getConfig();
		try {
			await config.update(CONFIG_KEYS.ActiveInstanceId, this.instanceId, true);
			log(LogLevel.Info, `Set instance ${this.instanceId} as active for Discord Presence`);
		} catch (error) {
			log(LogLevel.Error, `Failed to set active instance: ${error}`);
		}
	}

	async clearActiveInstance(): Promise<void> {
		const config = getConfig();
		const currentActiveId = config[CONFIG_KEYS.ActiveInstanceId] as string;

		if (currentActiveId === this.instanceId) {
			try {
				await config.update(CONFIG_KEYS.ActiveInstanceId, '', true);
				log(LogLevel.Info, `Cleared active instance ${this.instanceId}`);
			} catch (error) {
				log(LogLevel.Error, `Failed to clear active instance: ${error}`);
			}
		}

		this.cleanup();
	}

	async showInstanceSelector(): Promise<void> {
		const instances = await this.getAvailableInstances();

		if (instances.length <= 1) {
			void window.showInformationMessage('Only one VS Code instance detected');
			return;
		}

		const currentActiveId = getConfig()[CONFIG_KEYS.ActiveInstanceId] as string;

		const items = instances.map((instance) => ({
			label: `${instance.workspaceName} (PID: ${instance.pid})`,
			description:
				instance.id === this.instanceId ? 'Current instance' : instance.id === currentActiveId ? 'Active instance' : '',
			detail: `Instance ID: ${instance.id}`,
			instanceId: instance.id,
		}));

		const selected = await window.showQuickPick(items, {
			placeHolder: 'Select which VS Code instance should send Discord Presence data',
			canPickMany: false,
		});

		if (selected) {
			const config = getConfig();
			try {
				await config.update(CONFIG_KEYS.ActiveInstanceId, selected.instanceId, true);
				void window.showInformationMessage(`Set "${selected.label}" as active for Discord Presence`);
			} catch (error) {
				void window.showErrorMessage(`Failed to set active instance: ${error}`);
			}
		}
	}

	private async getAvailableInstances(): Promise<InstanceInfo[]> {
		try {
			if (!existsSync(this.instancesDir)) {
				return [this.instanceInfo];
			}

			const files = readdirSync(this.instancesDir);
			const instances: InstanceInfo[] = [];

			for (const file of files) {
				if (!file.endsWith('.json')) continue;

				try {
					const filePath = join(this.instancesDir, file);
					const content = readFileSync(filePath, 'utf8');
					const instance: InstanceInfo = JSON.parse(content);

					if (this.isProcessRunning(instance.pid)) {
						instances.push(instance);
					}
				} catch (error) {
					log(LogLevel.Debug, `Failed to read instance file ${file}: ${error}`);
				}
			}

			return instances.length > 0 ? instances : [this.instanceInfo];
		} catch (error) {
			log(LogLevel.Error, `Failed to get available instances: ${error}`);
			return [this.instanceInfo];
		}
	}

	private isProcessRunning(pid: number): boolean {
		try {
			process.kill(pid, 0);
			return true;
		} catch {
			return false;
		}
	}

	private cleanup(): void {
		if (this.cleanupInterval) {
			clearInterval(this.cleanupInterval);
			this.cleanupInterval = undefined;
		}

		try {
			if (existsSync(this.instanceFile)) {
				unlinkSync(this.instanceFile);
				log(LogLevel.Debug, `Cleaned up instance file for ${this.instanceId}`);
			}
		} catch (error) {
			log(LogLevel.Error, `Failed to cleanup instance file: ${error}`);
		}
	}
}

export const instanceManager = new InstanceManager();
