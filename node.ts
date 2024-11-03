// src/node.ts

import express, { Request, Response, Application, RequestHandler } from 'express';
import bodyParser from 'body-parser';
import axios, { AxiosResponse } from 'axios';
import { Blockchain, BlockData } from './blockchain';
import { Block, Transaction } from './block';

// Ustawienie serwera Express
const app: Application = express();
app.use(bodyParser.json({ limit: '10mb' }));

// Pobranie argumentów z wiersza poleceń
const PORT: number = parseInt(process.argv[2], 10) || 5000;
const initialPeerAddresses: string[] = process.argv.slice(3);

// Zdefiniowanie adresu node na podstawie PORT
const nodeAddress: string = `http://localhost:${PORT}`;

// Inicjalizacja Blockchain
const blockchain = new Blockchain();
const peers: Set<string> = new Set();

// Dodanie początkowych peerów, jeśli zostały podane
initialPeerAddresses.forEach(peer => {
    if (peer !== nodeAddress) { // Unikaj dodawania samego siebie jako peer
        peers.add(peer);
    }
});

// Flaga kontrolująca kopanie
let shouldMine: boolean = true;

// Funkcja do sprawdzania, czy transakcja została już przetworzona
const isTransactionProcessed = (transaction: Transaction): boolean => {
    const txHash = blockchain.computeTransactionHash(transaction);
    return blockchain.processedTransactions.has(txHash);
};

// Funkcja do sprawdzania, czy blok został już przetworzony
const isBlockProcessed = (block: Block): boolean => {
    return blockchain.processedBlocks.has(block.hash);
};

// Handler dla nowych transakcji
const newTransactionHandler: RequestHandler = async (req: Request, res: Response): Promise<void> => {
    console.log('Otrzymano żądanie /new_transaction:', req.body);
    const transaction: Transaction = req.body;
    const requiredFields: string[] = ['author', 'content'];
    if (!transaction || !requiredFields.every(field => transaction.hasOwnProperty(field))) {
        res.status(400).send('Nieprawidłowe dane transakcji');
        return;
    }

    // Sprawdzenie, czy transakcja została już przetworzona
    if (isTransactionProcessed(transaction)) {
        console.log('Transakcja już została przetworzona, pomijam broadcast.');
        res.status(200).send('Transakcja już została przetworzona');
        return;
    }

    blockchain.addTransaction(transaction);
    await broadcastTransaction(transaction);
    res.status(201).send('Transakcja dodana');
};
app.post('/new_transaction', newTransactionHandler);

// Handler do pobierania łańcucha bloków
const getChainHandler: RequestHandler = (req: Request, res: Response): void => {
    blockchain.logChain(blockchain.getChain());
    res.json(blockchain.getChain());
};
app.get('/chain', getChainHandler);

// Handler do rejestracji nowego node'a
const registerNodeHandler: RequestHandler = async (req: Request, res: Response): Promise<void> => {
    const newNodeAddress: string = req.body.node_address;
    if (!newNodeAddress) {
        res.status(400).send('Nieprawidłowe dane');
        return;
    }

    if (newNodeAddress === nodeAddress) {
        res.status(400).send('Nie można zarejestrować samego siebie');
        return;
    }

    if (!peers.has(newNodeAddress)) {
        peers.add(newNodeAddress);
        console.log(`Nowy node zarejestrowany: ${newNodeAddress}`);
        await broadcastNewNode(newNodeAddress);
    } else {
        console.log(`Node ${newNodeAddress} już jest zarejestrowany`);
    }

    res.json(blockchain.getChain());
};
app.post('/register_node', registerNodeHandler);

// Handler do dodawania nowego bloku
const addBlockHandler: RequestHandler = async (req: Request, res: Response): Promise<void> => {
    try {
        console.log('Otrzymano żądanie /add_block:', req.body);
        const blockData: BlockData = req.body;

        // Sprawdzenie, czy blok został już przetworzony
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
            // Konflikt - rozwiązywanie
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
            // Broadcast nowego bloku tylko jeśli został pomyślnie dodany
            const blockToBroadcast: BlockData = { ...newBlock.toDict(), hash: newBlock.hash };
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

// Handler do kopania nowego bloku
const mineHandler: RequestHandler = async (req: Request, res: Response): Promise<void> => {
    try {
        const result: number | false = blockchain.mine();
        if (result) {
            const newBlock = blockchain.getLastBlock();

            // Broadcast nowego bloku
            const blockToBroadcast: BlockData = { ...newBlock.toDict(), hash: newBlock.hash };
            console.log(`Blok #${result} został dodany do łańcucha i broadcastowany.`);
            await broadcastBlock(blockToBroadcast);

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
    } catch (error: any) {
        console.error(`Błąd podczas kopania: ${error.message}`);
        res.status(500).send('Błąd podczas kopania');
    }
};
app.get('/mine', mineHandler);

// Funkcja do broadcastowania transakcji do wszystkich peerów
const broadcastTransaction = async (transaction: Transaction): Promise<void> => {
    const broadcastPromises = Array.from(peers).map(async (peer) => {
        try {
            // Opcjonalnie, unikaj wysyłania transakcji do peer'a, który ją wysłał
            await axios.post(`${peer}/new_transaction`, transaction);
            console.log(`Transakcja broadcastowana do peer ${peer}`);
        } catch (error: any) {
            console.log(`Nie można wysłać transakcji do peer ${peer}: ${error.message}`);
        }
    });

    await Promise.all(broadcastPromises);
};

// Funkcja do broadcastowania bloku do wszystkich peerów
const broadcastBlock = async (block: BlockData): Promise<void> => {
    const broadcastPromises = Array.from(peers).map(async (peer) => {
        try {
            // Opcjonalnie, unikaj wysyłania bloku do peer'a, który go wysłał
            await axios.post(`${peer}/add_block`, block);
            console.log(`Blok broadcastowany do peer ${peer}`);
        } catch (error: any) {
            console.log(`Nie można wysłać bloku do peer ${peer}: ${error.message}`);
        }
    });

    await Promise.all(broadcastPromises);
};

// Funkcja do broadcastowania nowego node'a do wszystkich peerów
const broadcastNewNode = async (newNodeAddress: string): Promise<void> => {
    const broadcastPromises = Array.from(peers).map(async (peer) => {
        try {
            // Unikaj broadcastowania do samego siebie
            if (peer !== newNodeAddress) {
                await axios.post(`${peer}/register_node`, { node_address: newNodeAddress });
                console.log(`Nowy node broadcastowany do peer ${peer}`);
            }
        } catch (error: any) {
            console.log(`Nie można broadcastować node'a do peer ${peer}: ${error.message}`);
        }
    });

    await Promise.all(broadcastPromises);
};

// Funkcja do sprawdzania najnowszego bloku
const getLatestBlock = async (): Promise<number> => {
    try {
        const response: AxiosResponse = await axios.get(`${nodeAddress}/chain`);
        const chain: BlockData[] = response.data;
        if (chain.length === 0) return 0;
        return chain[chain.length - 1].index;
    } catch (error: any) {
        console.log(`Błąd podczas pobierania łańcucha: ${error.message}`);
        return 0;
    }
};

// Funkcja kopiąca
const startMining = async (): Promise<void> => {
    while (shouldMine) {
        try {
            const response: AxiosResponse = await axios.get(`${nodeAddress}/mine`);
            console.log(response.data.message);
            if (response.data.success) {
                console.log('Nowy blok został dodany. Restartowanie kopania za 10 sekund.');
                // Poczekaj 10 sekund przed ponownym rozpoczęciem kopania
                await new Promise(resolve => setTimeout(resolve, 10000));
            }
        } catch (error: any) {
            // Sprawdź, czy błąd wynika z konfliktu
            if (error.response && error.response.status === 400) {
                console.log('Blok z tym samym indeksem został już dodany. Przerywam kopanie.');
                shouldMine = false;
            } else {
                console.log(`Błąd podczas kopania: ${error.message}`);
            }
        }
        await new Promise(resolve => setTimeout(resolve, 10000)); // Czekaj 10 sekund przed kolejną próbą
    }
};

// Funkcja monitorująca najnowszy blok
const monitorChain = async (): Promise<void> => {
    let lastBlockIndex = await getLatestBlock();
    while (shouldMine) {
        const currentBlockIndex = await getLatestBlock();
        if (currentBlockIndex > lastBlockIndex) {
            console.log('Wykryto nowy blok. Przerywam kopanie.');
            // shouldMine = false;
            break;
        }
        lastBlockIndex = currentBlockIndex;
        await new Promise(resolve => setTimeout(resolve, 5000)); // Sprawdzaj co 5 sekund
    }
};

// Funkcja do rejestracji u wszystkich peerów początkowych
const registerWithPeers = async (): Promise<void> => {
    for (const peer of initialPeerAddresses) {
        if (peer !== nodeAddress) { // Unikaj rejestracji samego siebie
            try {
                await axios.post(`${peer}/register_node`, { node_address: nodeAddress });
                console.log(`Zarejestrowano node'a w peer ${peer}`);
            } catch (error: any) {
                console.log(`Nie można zarejestrować node'a w peer ${peer}: ${error.message}`);
            }
        }
    }
};

// Funkcja do uruchomienia kopania i monitorowania
const startMiningAndMonitoring = async (): Promise<void> => {
    startMining();
    monitorChain();
};

// Uruchomienie serwera i minera
const start = async () => {
    await registerWithPeers();
    // Uruchomienie kopania i monitorowania w równoległych procesach
    startMiningAndMonitoring();
};

start();

// Start serwera Express
app.listen(PORT, () => {
    console.log(`Node działa na porcie ${PORT}`);
});
