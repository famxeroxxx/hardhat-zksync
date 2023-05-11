import path from "path";
import fsExtra from "fs-extra";
import chalk from "chalk";
import { spawnSync } from 'child_process';

import { download } from 'hardhat/internal/util/download';
import { Mutex } from 'hardhat/internal/vendor/await-semaphore';

import { getZksolcUrl, isURL, isVersionInRange, saltFromUrl } from "../utils";
import { 
    COMPILER_BINARY_CORRUPTION_ERROR, 
    COMPILER_VERSION_INFO_FILE_DOWNLOAD_ERROR, 
    COMPILER_VERSION_INFO_FILE_NOT_FOUND_ERROR, 
    COMPILER_VERSION_RANGE_ERROR, 
    COMPILER_VERSION_WARNING, 
    DEFAULT_COMPILER_VERSION_INFO_CACHE_PERIOD, 
    ZKSOLC_BIN_REPOSITORY, 
    ZKSOLC_BIN_VERSION_INFO 
} from "../constants";
import { ZkSyncSolcPluginError } from './../errors';

export interface CompilerVersionInfo {
    latest: string;
    minVersion: string;
}

/**
 * This class is responsible for downloading the zksolc binary.
 */
export class ZksolcCompilerDownloader {

    public static async getDownloaderWithVersionValidated(
        version: string,
        configCompilerPath: string,
        compilersDir: string,
    ): Promise<ZksolcCompilerDownloader> {
        if (!ZksolcCompilerDownloader._instance) {
            ZksolcCompilerDownloader._instance = new ZksolcCompilerDownloader(version, configCompilerPath, compilersDir);

            let compilerVersionInfo = await ZksolcCompilerDownloader._instance._getCompilerVersionInfo();
            if (compilerVersionInfo === undefined || (await ZksolcCompilerDownloader._instance._shouldDownloadCompilerVersionInfo())) {
                try {
                    await ZksolcCompilerDownloader._instance._downloadCompilerVersionInfo();
                } catch (e: any) {
                    throw new ZkSyncSolcPluginError(COMPILER_VERSION_INFO_FILE_DOWNLOAD_ERROR);
                }
                compilerVersionInfo = await ZksolcCompilerDownloader._instance._getCompilerVersionInfo();
            }

            if (compilerVersionInfo === undefined) {
                throw new ZkSyncSolcPluginError(COMPILER_VERSION_INFO_FILE_NOT_FOUND_ERROR);
            }

            if (version === 'latest' || version === compilerVersionInfo.latest) {
                ZksolcCompilerDownloader._instance._version = compilerVersionInfo.latest;
            } else if (!isVersionInRange(version, compilerVersionInfo)) {
                throw new ZkSyncSolcPluginError(COMPILER_VERSION_RANGE_ERROR(version, compilerVersionInfo.minVersion, compilerVersionInfo.latest));
            } else {
                console.info(chalk.yellow(COMPILER_VERSION_WARNING(version, compilerVersionInfo.latest)));
            };
        }

        return ZksolcCompilerDownloader._instance;
    }

    private static _instance: ZksolcCompilerDownloader;
    public static defaultCompilerVersionInfoCachePeriod = DEFAULT_COMPILER_VERSION_INFO_CACHE_PERIOD;
    private readonly _mutex = new Mutex();
    private _isCompilerPathURL: boolean;

    /** 
     * Use `getDownloaderWithVersionValidated` to create an instance of this class.
     */
    private constructor(
        private _version: string,
        private readonly _configCompilerPath: string,
        private readonly _compilersDirectory: string,
        private readonly _compilerVersionInfoCachePeriodMs = ZksolcCompilerDownloader.defaultCompilerVersionInfoCachePeriod,
        private readonly _downloadFunction: typeof download = download
    ) {
        this._isCompilerPathURL = isURL(_configCompilerPath);
    }

    public getCompilerPath(): string {
        let salt = '';

        if (this._isCompilerPathURL) {
            // hashed url used as a salt to avoid name collisions
            salt = saltFromUrl(this._configCompilerPath);
        }

        return path.join(this._compilersDirectory, 'zksolc', `zksolc-v${this._version}${salt ? '-' : ''}${salt}`);
    }

    public async isCompilerDownloaded(): Promise<boolean> {
        const compilerPath = this.getCompilerPath();
        return fsExtra.pathExists(compilerPath);
    }

    private async _shouldDownloadCompilerVersionInfo(): Promise<boolean> {
        const compilerVersionInfoPath = this._getCompilerVersionInfoPath();
        if (!(await fsExtra.pathExists(compilerVersionInfoPath))) {
            return true;
        }

        const stats = await fsExtra.stat(compilerVersionInfoPath);
        const age = new Date().valueOf() - stats.ctimeMs;

        return age > this._compilerVersionInfoCachePeriodMs;
    }

    private _getCompilerVersionInfoPath(): string {
        return path.join(this._compilersDirectory, 'zksolc', 'compilerVersionInfo.json');
    }

    public async downloadCompiler(): Promise<void> {
        await this._mutex.use(async () => {
            let compilerVersionInfo = await this._getCompilerVersionInfo();

            if (compilerVersionInfo === undefined && (await this._shouldDownloadCompilerVersionInfo())) {
                try {
                    await this._downloadCompilerVersionInfo();
                } catch (e: any) {
                    throw new ZkSyncSolcPluginError(COMPILER_VERSION_INFO_FILE_DOWNLOAD_ERROR)
                }

                compilerVersionInfo = await this._getCompilerVersionInfo();
            }

            if (compilerVersionInfo === undefined) {
                throw new ZkSyncSolcPluginError(COMPILER_VERSION_INFO_FILE_NOT_FOUND_ERROR);
            }
            if (!isVersionInRange(this._version, compilerVersionInfo)) {
                throw new ZkSyncSolcPluginError(COMPILER_VERSION_RANGE_ERROR(this._version, compilerVersionInfo.minVersion, compilerVersionInfo.latest));
            }

            try {
                await this._downloadCompiler();
            } catch (e: any) {
                throw new ZkSyncSolcPluginError(e.message.split('\n')[0]);
            }

            await this._postProcessCompilerDownload();
            await this.verifyCompiler();
        });
    }

    private async _downloadCompilerVersionInfo(): Promise<void> {
        const url = `${ZKSOLC_BIN_VERSION_INFO}/version.json`;
        const downloadPath = this._getCompilerVersionInfoPath();

        await this._downloadFunction(url, downloadPath);
    }

    private async _downloadCompiler(): Promise<string> {
        let url = this._configCompilerPath as string;
        if (!this._isCompilerPathURL) {
            url = getZksolcUrl(ZKSOLC_BIN_REPOSITORY, this._version);
        }

        const downloadPath = this.getCompilerPath();
        await this._downloadFunction(url, downloadPath);
        return downloadPath;
    }

    private async _readCompilerVersionInfo(compilerVersionInfoPath: string): Promise<CompilerVersionInfo> {
        return fsExtra.readJSON(compilerVersionInfoPath);
    }

    private async _getCompilerVersionInfo(): Promise<CompilerVersionInfo | undefined> {
        const compilerVersionInfoPath = this._getCompilerVersionInfoPath();
        if (!(await fsExtra.pathExists(compilerVersionInfoPath))) {
            return undefined;
        }

        return await this._readCompilerVersionInfo(compilerVersionInfoPath);
    }

    private async _postProcessCompilerDownload(): Promise<void> {
        const compilerPath = this.getCompilerPath();
        fsExtra.chmodSync(compilerPath, 0o755);
    }

    public async verifyCompiler(): Promise<void> {
        const compilerPath = this.getCompilerPath();

        const versionOutput = spawnSync(compilerPath, ['--version']);
        const version = versionOutput.stdout
            ?.toString()
            .match(/\d+\.\d+\.\d+/)
            ?.toString();

        if (versionOutput.status !== 0 || version == null) {
            throw new ZkSyncSolcPluginError(COMPILER_BINARY_CORRUPTION_ERROR);
        }

        if (this._version !== version) {
            console.info(chalk.yellow(`zksolc compiler version mismatch: expected ${this._version}, got ${version}`));
        }
    }
}