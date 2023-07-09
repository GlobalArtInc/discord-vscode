import { basename } from 'path';
import { TextDocument, workspace, extensions, WorkspaceConfiguration } from 'vscode';

import { KNOWN_EXTENSIONS, KNOWN_LANGUAGES } from './constants';
import { log, LogLevel } from './logger';
import type { API, GitExtension } from './git';

let git: API | null | undefined;

type WorkspaceExtensionConfiguration = WorkspaceConfiguration & {
  enabled: boolean;
  detailsIdling: string;
  detailsEditing: string;
  detailsDebugging: string;
  lowerDetailsIdling: string;
  lowerDetailsEditing: string;
  lowerDetailsDebugging: string;
  lowerDetailsNoWorkspaceFound: string;
  largeImageIdling: string;
  largeImage: string;
  smallImage: string;
  suppressNotifications: boolean;
  workspaceExcludePatterns: string[];
  swapBigAndSmallImage: boolean;
  removeDetails: boolean;
  removeLowerDetails: boolean;
  removeTimestamp: boolean;
  removeRemoteRepository: boolean;
  idleTimeout: number;
};

export function getConfig(): WorkspaceExtensionConfiguration {
  return workspace.getConfiguration('discord') as WorkspaceExtensionConfiguration;
}

export const toLower = (str: string): string => str.toLowerCase();

export const toUpper = (str: string): string => str.toUpperCase();

export const toTitle = (str: string): string => str.toLowerCase().replace(/^\w/, (c) => c.toUpperCase());

export function resolveFileIcon(document: TextDocument): string {
  const filename = basename(document.fileName);
  const findKnownExtension = Object.keys(KNOWN_EXTENSIONS)
  .sort((a, b) => {
    const aIsRegular = KNOWN_EXTENSIONS[a].isRegular || false;
    const bIsRegular = KNOWN_EXTENSIONS[b].isRegular || false;

    if (aIsRegular && !bIsRegular) {
      return -1;
    } else if (!aIsRegular && bIsRegular) {
      return 1;
    }

    return 0;
  })
  .find((key) => {
    if (filename.endsWith(key)) {
      return true;
    }
    const match = /^\/(.*)\/([mgiy]+)$/.exec(key);
    if (!match) {
      return false;
    }

    const regex = new RegExp(match[1], match[2]);
    return regex.test(filename);
  });
  const findKnownLanguage = KNOWN_LANGUAGES.find((key) => key.language === document.languageId);
  const fileIcon = findKnownExtension
    ? KNOWN_EXTENSIONS[findKnownExtension]
    : findKnownLanguage
    ? findKnownLanguage.image
    : null;

  return typeof fileIcon === 'string' ? fileIcon : fileIcon?.image ?? 'text';
}

export async function getGit(): Promise<API | null | undefined> {
  if (git || git === null) {
    return git;
  }
  
  try {
    log(LogLevel.Debug, 'Loading git extension');
    const gitExtension = extensions.getExtension<GitExtension>('vscode.git');
    if (!gitExtension?.isActive) {
      log(LogLevel.Trace, 'Git extension not activated, activating...');
      await gitExtension?.activate();
    }
    git = gitExtension?.exports.getAPI(1);
  } catch (error) {
    git = null;
    log(LogLevel.Error, `Failed to load git extension, is git installed?; ${error as string}`);
  }

  return git;
}
