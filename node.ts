// src/node.ts

import express, { Request, Response, Application, RequestHandler } from 'express';
import bodyParser from 'body-parser';
import axios from 'axios';
import { Blockchain, BlockData } from './blockchain';
import { Block, Transaction } from './block';

const app: Application = express();
app.use(bodyParser.json({ limit: '10mb' }));

const DIFFICULTY: number = parseInt(process.argv[3], 10) || 5; // Domyślna trudność to 5

const blockchain = new Blockchain(DIFFICULTY);
const peers: Set<string> = new Set();

// Check if a transaction has already been processed.
const isTransactionProcessed = (transaction: Transaction): boolean => {
    const txHash = blockchain.computeTransactionHash(transaction);
    return blockchain.processedTransactions.has(txHash);
};

// Check if a block has already been processed.
const isBlockProcessed = (block: Block): boolean => {
    return blockchain.processedBlocks.has(block.hash);
};

const newTransactionHandler: RequestHandler = (req: Request, res: Response): void => {
    console.log('Otrzymano żądanie /new_transaction:', req.body);
    const transaction: Transaction = req.body;
    const requiredFields: string[] = ['author', 'content'];
    if (!transaction || !requiredFields.every(field => transaction.hasOwnProperty(field))) {
        res.status(400).send('Nieprawidłowe dane transakcji');
        return;
    }

    // Check if the transaction has already been processed
    if (isTransactionProcessed(transaction)) {
        console.log('Transakcja już została przetworzona, pomijam broadcast.');
        res.status(200).send('Transakcja już została przetworzona');
        return;
    }

    blockchain.addTransaction(transaction);
    broadcastTransaction(transaction);
    res.status(201).send('Transakcja dodana');
};
app.post('/new_transaction', newTransactionHandler);

const getChainHandler: RequestHandler = (req: Request, res: Response): void => {
    blockchain.logChain(blockchain.getChain());
    res.json(blockchain.getChain());
};
app.get('/chain', getChainHandler);

const registerNodeHandler: RequestHandler = (req: Request, res: Response): void => {
    const nodeAddress: string = req.body.node_address;
    if (!nodeAddress) {
        res.status(400).send('Nieprawidłowe dane');
        return;
    }
    peers.add(nodeAddress);
    res.json(blockchain.getChain());
};
app.post('/register_node', registerNodeHandler);

const addBlockHandler: RequestHandler = async (req: Request, res: Response): Promise<void> => {
    try {
        console.log('Otrzymano żądanie /add_block:', req.body);
        const blockData: BlockData = req.body;

        // Check if the block has already been processed
        if (blockchain.processedBlocks.has(blockData.hash)) {
            console.log('Blok już został przetworzony, pomijam broadcast.');
            res.status(200).send('Blok już został przetworzony');
            return;
        }

        const newBlock = new Block(
            blockData.index,
            blockData.transactions,
            blockData.previousHash,
            blockData.nonce,
            blockData.timestamp
        );
        newBlock.hash = blockData.hash;

        const added: boolean = blockchain.addBlock(newBlock, newBlock.hash);
        if (!added) {
            // Conflict - resolve it
            const resolved: boolean = await blockchain.resolveConflicts(Array.from(peers));
            if (resolved) {
                console.log('Łańcuch został zastąpiony po konflikcie.');
                res.status(201).send('Łańcuch został zastąpiony');
                return;
            } else {
                console.log('Blok odrzucony ze względu na konflikt.');
                res.status(400).send('Blok odrzucony');
                return;
            }
        } else {
            // Broadcast the new block only if it was successfully added
            const blockToBroadcast: BlockData = {...newBlock.toDict(), hash: newBlock.hash};
            console.log(`Blok #${newBlock.index} został dodany do łańcucha i broadcastowany.`);

            await broadcastBlock(blockToBroadcast);
            res.status(201).send('Blok dodany do łańcucha');
        }
    } catch (error: any) {
        console.error('Błąd podczas przetwarzania /add_block:', error);
        res.status(500).send('Internal Server Error');
    }
};
app.post('/add_block', addBlockHandler);

const mineHandler: RequestHandler = (req: Request, res: Response): void => {
    const result: number | false = blockchain.mine();
    if (result) {
        const newBlock = blockchain.getLastBlock();

        // Broadcast the new block
        const blockToBroadcast: BlockData = { ...newBlock.toDict(), hash: newBlock.hash };
        console.log(`Blok #${result} został dodany do łańcucha i broadcastowany.`);
        broadcastBlock(blockToBroadcast)

        res.status(200).json({
            success: true,
            message: `Blok #${result} został dodany do łańcucha`
        });
    } else {
        res.status(200).json({
            success: false,
            message: 'Brak transakcji do zatwierdzenia'
        });
    }
};
app.get('/mine', mineHandler);

const broadcastTransaction = async (transaction: Transaction): Promise<void> => {
    for (const peer of peers) {
        try {
            // Optionally, avoid sending back to the peer that sent this transaction
            await axios.post(`${peer}/new_transaction`, transaction);
            console.log(`Transakcja broadcastowana do peer ${peer}`);
        } catch (error: any) {
            console.log(`Nie można wysłać transakcji do peer ${peer}: ${error.message}`);
        }
    }
};

const broadcastBlock = async (block: BlockData): Promise<void> => {
    for (const peer of peers) {
        try {
            // Optionally, avoid sending back to the peer that sent this block
            console.log(`Blok broadcastowany do peer ${peer}`);
            await axios.post(`${peer}/add_block`, block);
        } catch (error: any) {
            console.log(`Nie można wysłać bloku do peer ${peer}: ${error.message}`);
        }
    }
};

// Retrieve the port number from command-line arguments or default to 5000
const PORT: number = parseInt(process.argv[2], 10) || 5000;

// Start the Express server
app.listen(PORT, () => {
    console.log(`Node działa na porcie ${PORT}`);
});
