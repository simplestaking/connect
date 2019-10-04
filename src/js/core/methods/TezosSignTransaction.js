/* @flow */
'use strict';

import AbstractMethod from './AbstractMethod';
import { validateParams, getFirmwareRange } from './helpers/paramsValidator';
import { getMiscNetwork } from '../../data/CoinInfo';
import { validatePath } from '../../utils/pathUtils';
import * as helper from './helpers/tezosSignTx';

import type { TezosOperation, TezosSecondaryOperation } from '../../types/tezos';
import type { TezosTransaction, TezosSignedTx } from '../../types/trezor';
import type { CoreMessage } from '../../types';

type Params = {
    transaction: TezosTransaction,
}

export default class TezosSignTransaction extends AbstractMethod {
    params: Params;

    constructor(message: CoreMessage) {
        super(message);
        this.requiredPermissions = ['read', 'write'];
        this.firmwareRange = getFirmwareRange(this.name, getMiscNetwork('Tezos'), this.firmwareRange);
        this.info = 'Sign Tezos transaction';

        const payload: Object = message.payload;

        // validate incoming parameters
        validateParams(payload, [
            { name: 'path', obligatory: true },
            { name: 'branch', type: 'string', obligatory: true },
            { name: 'operation', obligatory: true },
            { name: 'secondaryOperation', obligatory: false},
        ]);

        const path = validatePath(payload.path, 3);
        const branch: string = payload.branch;
        const operation: TezosOperation = payload.operation;
        const secondaryOperation: TezosSecondaryOperation = payload.secondaryOperation
        const transaction = helper.createTx(path, branch, operation, secondaryOperation);

        this.params = {
            transaction,
        };
    }

    async run(): Promise<TezosSignedTx> {
        return await this.device.getCommands().tezosSignTransaction(
            this.params.transaction,
        );
    }
}
