/* @flow */

import BigNumber from 'bignumber.js';
import AbstractMethod from './AbstractMethod';
import Discovery from './helpers/Discovery';
import { validateParams, getFirmwareRange } from './helpers/paramsValidator';
import { validatePath } from '../../utils/pathUtils';
import { resolveAfter } from '../../utils/promiseUtils';

import * as UI from '../../constants/ui';
import { getBitcoinNetwork, fixCoinInfoNetwork } from '../../data/CoinInfo';

import { formatAmount } from '../../utils/formatUtils';
import { NO_COIN_INFO, backendNotSupported } from '../../constants/errors';

import { initBlockchain } from '../../backend/BlockchainLink';

import TransactionComposer from './tx/TransactionComposer';
import {
    validateHDOutput,
    inputToTrezor,
    outputToTrezor,
    getReferencedTransactions,
    transformReferencedTransactions,
} from './tx';
import signTx from './helpers/signtx';
import verifyTx from './helpers/signtxVerify';

import { UiMessage } from '../../message/builder';

import type {
    BuildTxOutputRequest,
    BuildTxResult,
} from 'hd-wallet';
import type { CoreMessage, BitcoinNetworkInfo } from '../../types';
import type { SignedTx } from '../../types/trezor';
import type { $$ComposeTransaction as Payload } from '../../types/params';
import type { PrecomposedTransaction } from '../../types/response';
import type { DiscoveryAccount, AccountUtxo } from '../../types/account';

type Params = {
    outputs: BuildTxOutputRequest[],
    coinInfo: BitcoinNetworkInfo,
    push: boolean,
    account?: $ElementType<Payload, 'account'>,
    feeLevels?: $ElementType<Payload, 'feeLevels'>,
}

export default class ComposeTransaction extends AbstractMethod {
    params: Params;
    discovery: Discovery | typeof undefined;

    constructor(message: CoreMessage) {
        super(message);
        this.requiredPermissions = ['read', 'write'];

        const payload: Object = message.payload;
        // validate incoming parameters
        validateParams(payload, [
            { name: 'outputs', type: 'array', obligatory: true, allowEmpty: true },
            { name: 'coin', type: 'string', obligatory: true },
            { name: 'push', type: 'boolean' },
            { name: 'account', type: 'object' },
            { name: 'feeLevels', type: 'array' },
        ]);

        const coinInfo: ?BitcoinNetworkInfo = getBitcoinNetwork(payload.coin);
        if (!coinInfo) {
            throw NO_COIN_INFO;
        }
        if (!coinInfo.blockchainLink) {
            throw backendNotSupported(coinInfo.name);
        }

        // set required firmware from coinInfo support
        this.firmwareRange = getFirmwareRange(this.name, coinInfo, this.firmwareRange);

        // validate each output and transform into hd-wallet format
        const outputs: Array<BuildTxOutputRequest> = [];
        let total: BigNumber = new BigNumber(0);
        payload.outputs.forEach(out => {
            const output = validateHDOutput(out, coinInfo);
            if (typeof output.amount === 'string') {
                total = total.plus(output.amount);
            }
            outputs.push(output);
        });

        const sendMax: boolean = outputs.find(o => o.type === 'send-max') !== undefined;

        // there should be only one output when using send-max option
        if (sendMax && outputs.length > 1) {
            throw new Error('Only one output allowed when using "send-max" option.');
        }

        // if outputs contains regular items
        // check if total amount is not lower than dust limit
        // if (outputs.find(o => o.type === 'complete') !== undefined && total.lte(coinInfo.dustLimit)) {
        //     throw new Error('Total amount is too low. ');
        // }

        if (sendMax) {
            this.info = 'Send maximum amount';
        } else {
            this.info = `Send ${ formatAmount(total.toString(), coinInfo) }`;
        }

        this.useDevice = this.useUi = !payload.account && !payload.feeLevels;

        this.params = {
            outputs,
            coinInfo,
            account: payload.account,
            feeLevels: payload.feeLevels,
            push: payload.hasOwnProperty('push') ? payload.push : false,
        };
    }

    async precompose(account: $ElementType<Payload, 'account'>, feeLevels: $ElementType<Payload, 'feeLevels'>): Promise<PrecomposedTransaction[]> {
        const { coinInfo, outputs } = this.params;
        const composer = new TransactionComposer({
            account: {
                type: 'normal',
                label: 'normal',
                descriptor: 'normal',
                address_n: validatePath(account.path),
                addresses: account.addresses,
            },
            utxo: account.utxo,
            coinInfo,
            outputs,
        });

        // This is mandatory, hd-wallet expects current block height
        // TODO: make it possible without it (offline composing)
        const blockchain = await initBlockchain(this.params.coinInfo, this.postMessage);
        await composer.init(blockchain);
        return feeLevels.map(level => {
            composer.composeCustomFee(level.feePerUnit);
            const tx = composer.composed.custom;
            if (tx.type === 'final') {
                const inputs = tx.transaction.inputs.map(inp => inputToTrezor(inp, 0));
                const outputs = tx.transaction.outputs.sorted.map(out => outputToTrezor(out, coinInfo));
                return {
                    type: 'final',
                    max: tx.max,
                    totalSpent: tx.totalSpent,
                    fee: tx.fee,
                    feePerByte: tx.feePerByte,
                    bytes: tx.bytes,
                    transaction: {
                        inputs,
                        outputs,
                    },
                };
            }
            return tx;
        });
    }

    async run(): Promise<SignedTx | PrecomposedTransaction[]> {
        if (this.params.account && this.params.feeLevels) {
            return this.precompose(this.params.account, this.params.feeLevels);
        }

        // discover accounts and wait for user action
        const { account, utxo } = await this.selectAccount();

        // wait for fee selection
        const response: string | SignedTx = await this.selectFee(account, utxo);
        // check for interruption
        if (!this.discovery) {
            throw new Error('ComposeTransaction selectFee response received after dispose');
        }

        if (typeof response === 'string') {
            // back to account selection
            return this.run();
        } else {
            return response;
        }
    }

    async selectAccount(): Promise<{ account: DiscoveryAccount, utxo: AccountUtxo[] }> {
        const { coinInfo } = this.params;
        const blockchain = await initBlockchain(coinInfo, this.postMessage);
        const dfd = this.createUiPromise(UI.RECEIVE_ACCOUNT, this.device);

        if (this.discovery && this.discovery.completed) {
            const { discovery } = this;
            this.postMessage(new UiMessage(UI.SELECT_ACCOUNT, {
                type: 'end',
                coinInfo,
                accountTypes: discovery.types.map(t => t.type),
                accounts: discovery.accounts,
            }));
            const uiResp = await dfd.promise;
            const account = discovery.accounts[uiResp.payload];
            const utxo = await blockchain.getAccountUtxo(account.descriptor);
            return {
                account,
                utxo,
            };
        }
        // initialize backend

        const discovery = this.discovery || new Discovery({
            blockchain,
            commands: this.device.getCommands(),
        });
        this.discovery = discovery;

        discovery.on('progress', (accounts: Array<any>) => {
            this.postMessage(new UiMessage(UI.SELECT_ACCOUNT, {
                type: 'progress',
                // preventEmpty: true,
                coinInfo,
                accounts,
            }));
        });
        discovery.on('complete', () => {
            this.postMessage(new UiMessage(UI.SELECT_ACCOUNT, {
                type: 'end',
                coinInfo,
            }));
        });

        // get accounts with addresses (tokens)
        discovery.start('tokens').catch(error => {
            // catch error from discovery process
            dfd.reject(error);
        });

        // set select account view
        // this view will be updated from discovery events
        this.postMessage(new UiMessage(UI.SELECT_ACCOUNT, {
            type: 'start',
            accountTypes: discovery.types.map(t => t.type),
            coinInfo,
        }));

        // wait for user action
        const uiResp = await dfd.promise;
        discovery.removeAllListeners();
        discovery.stop();

        if (!discovery.completed) {
            await resolveAfter(501); // temporary solution, TODO: immediately resolve will cause "device call in progress"
        }

        const account = discovery.accounts[uiResp.payload];
        this.params.coinInfo = fixCoinInfoNetwork(this.params.coinInfo, account.address_n);
        const utxo = await blockchain.getAccountUtxo(account.descriptor);
        return {
            account,
            utxo,
        };
    }

    async selectFee(account: DiscoveryAccount, utxo: AccountUtxo[]): Promise<string | SignedTx> {
        const { coinInfo, outputs } = this.params;

        // get backend instance (it should be initialized before)
        const blockchain = await initBlockchain(coinInfo, this.postMessage);
        const composer = new TransactionComposer({
            account,
            utxo,
            coinInfo,
            outputs,
        });
        await composer.init(blockchain);

        // try to compose multiple transactions with different fee levels
        // check if any of composed transactions is valid
        const hasFunds = composer.composeAllFeeLevels();
        if (!hasFunds) {
            // show error view
            this.postMessage(new UiMessage(UI.INSUFFICIENT_FUNDS));
            // wait few seconds...
            await resolveAfter(2000, null);
            // and go back to discovery
            return 'change-account';
        }

        // set select account view
        // this view will be updated from discovery events
        this.postMessage(new UiMessage(UI.SELECT_FEE, {
            feeLevels: composer.getFeeLevelList(),
            coinInfo: this.params.coinInfo,
        }));

        // wait for user action
        return await this._selectFeeUiResponse(composer);
    }

    async _selectFeeUiResponse(composer: TransactionComposer): Promise<string | SignedTx> {
        const resp = await this.createUiPromise(UI.RECEIVE_FEE, this.device).promise;
        switch (resp.payload.type) {
            case 'compose-custom':
                // recompose custom fee level with requested value
                composer.composeCustomFee(resp.payload.value);
                this.postMessage(new UiMessage(UI.UPDATE_CUSTOM_FEE, {
                    feeLevels: composer.getFeeLevelList(),
                    coinInfo: this.params.coinInfo,
                }));

                // wait for user action
                return await this._selectFeeUiResponse(composer);

            case 'send':
                return await this._sign(composer.composed[resp.payload.value]);

            default:
                return 'change-account';
        }
    }

    async _sign(tx: BuildTxResult): Promise<SignedTx> {
        if (tx.type !== 'final') throw new Error('Trying to sign unfinished tx');

        const { coinInfo } = this.params;

        let refTxs = [];
        const refTxsIds = getReferencedTransactions(tx.transaction.inputs);
        if (refTxsIds.length > 0) {
            const blockchain = await initBlockchain(coinInfo, this.postMessage);
            const bjsRefTxs = await blockchain.getReferencedTransactions(refTxsIds);
            refTxs = transformReferencedTransactions(bjsRefTxs);
        }

        const timestamp = coinInfo.hasTimestamp ? Math.round(new Date().getTime() / 1000) : undefined;
        // const inputs = tx.transaction.inputs.map(inp => inputToTrezor(inp, (0xffffffff - 2))); // TODO: RBF
        const inputs = tx.transaction.inputs.map(inp => inputToTrezor(inp, 0));
        const outputs = tx.transaction.outputs.sorted.map(out => outputToTrezor(out, coinInfo));

        const response = await signTx(
            this.device.getCommands().typedCall.bind(this.device.getCommands()),
            inputs,
            outputs,
            refTxs,
            { timestamp },
            coinInfo,
        );

        await verifyTx(
            this.device.getCommands().getHDNode.bind(this.device.getCommands()),
            inputs,
            outputs,
            response.serializedTx,
            coinInfo,
        );

        if (this.params.push) {
            const blockchain = await initBlockchain(coinInfo, this.postMessage);
            const txid: string = await blockchain.pushTransaction(response.serializedTx);
            return {
                ...response,
                txid,
            };
        }

        return response;
    }

    dispose() {
        const { discovery } = this;
        if (discovery) {
            discovery.stop();
            discovery.removeAllListeners();
            this.discovery = undefined;
        }
    }
}
