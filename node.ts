// src/node.ts

import express, { Request, Response, Application, RequestHandler } from 'express';
import bodyParser from 'body-parser';
import axios, { AxiosResponse } from 'axios';
import { Blockchain, BlockData } from './blockchain';
import { Block, Transaction } from './block';
import { EventEmitter } from 'events';

// Utworzenie instancji EventEmitter
const eventEmitter = new EventEmitter();

// Ustawienie serwera Express
const app: Application = express();
app.use(bodyParser.json({ limit: '10mb' }));

// Pobranie argumentów z wiersza poleceń
const PORT: number = parseInt(process.argv[2], 10) || 5000;
const initialPeerAddresses: string[] = process.argv.slice(3);

// Zdefiniowanie adresu node na podstawie PORT
const nodeAddress: string = `http://localhost:${PORT}`;

// Inicjalizacja Blockchain z określoną trudnością
const DIFFICULTY: number = 5; // Możesz zmienić wartość trudności
const blockchain = new Blockchain(DIFFICULTY);
const peers: Set<string> = new Set();

// Dodanie początkowych peerów, jeśli zostały podane
initialPeerAddresses.forEach(peer => {
    if (peer !== nodeAddress) { // Unikaj dodawania samego siebie jako peer
        peers.add(peer);
    }
});

// Flagi kontrolujące kopanie
let miningInProgress: boolean = false;

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
    if (blockchain.isTransactionProcessed(transaction)) {
        console.log('Transakcja już została przetworzona, pomijam broadcast.');
        res.status(200).send('Transakcja już została przetworzona');
        return;
    }

    blockchain.addTransaction(transaction);
    await broadcastTransaction(transaction);

    // Emitowanie zdarzenia nowej transakcji
    eventEmitter.emit('newTransaction');

    // Rozpoczęcie kopania, jeśli nie trwa
    if (!miningInProgress) {
        startMining();
    }

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
        console.log('Peers:', peers);
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

        console.log(blockchain.processedBlocks)
        // Sprawdzenie, czy blok został już przetworzony
        if (blockchain.processedBlocks.has(blockData.hash)) {
            console.log('Blok już został przetworzony, pomijam.');
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

                // Emitowanie zdarzenia nowego bloku
                eventEmitter.emit('newBlock');
                return;
            } else {
                console.log('Blok odrzucony po uwzględnieniu rozwiązywania konfliktów.');
                res.status(400).send('Blok odrzucony');
                return;
            }
        } else {
            // Broadcast nowego bloku tylko jeśli został pomyślnie dodany
            const blockToBroadcast: BlockData = { ...newBlock.toDict(), hash: newBlock.hash };
            console.log(`Blok #${newBlock.index} został dodany do łańcucha i broadcastowany.`);

            await broadcastBlock(blockToBroadcast);
            res.status(201).send('Blok dodany do łańcucha');

            // Emitowanie zdarzenia nowego bloku
            eventEmitter.emit('newBlock');
        }
    } catch (error: any) {
        console.error('Błąd podczas przetwarzania /add_block:', error);
        res.status(500).send('Internal Server Error');
    }
};
app.post('/add_block', addBlockHandler);

// Funkcja do broadcastowania transakcji do wszystkich peerów
const broadcastTransaction = async (transaction: Transaction): Promise<void> => {
    const broadcastPromises = Array.from(peers).map(async (peer) => {
        try {
            // Unikaj wysyłania transakcji do samego siebie
            if (peer !== nodeAddress) {
                await axios.post(`${peer}/new_transaction`, transaction);
                console.log(`Transakcja broadcastowana do peer ${peer}`);
            }
        } catch (error: any) {
            console.log(`Nie można wysłać transakcji do peer ${peer}: ${error.message}`);
        }
    });

    await Promise.all(broadcastPromises);
};

const sendBlockToPeer = async (peer: string, block: BlockData): Promise<void> => {
    while (true) {
        try {
            await axios.post(`${peer}/add_block`, block);
            console.log(`Blok broadcastowany do peer ${peer}`);
            break; // Wyjdź z pętli, jeśli wysyłka się powiodła
        } catch (error: any) {
            if(error.status === 400) {
                console.log(`Blok został już przetworzony przez peer i rozwiązał konflikty ${peer}`);
                break;
            }
            console.log(`Nie można wysłać bloku do peer ${peer}: ${error.message}. Retrying in 1 second...`);
            await new Promise(resolve => setTimeout(resolve, 1000)); // Poczekaj 1 sekundę przed ponowną próbą
        }
    }
};

// Funkcja do broadcastowania bloku do wszystkich peerów
const broadcastBlock = async (block: BlockData): Promise<void> => {
    console.log('Peers:', peers);

    const broadcastPromises = Array.from(peers).map(async (peer) => {
        if (peer !== nodeAddress) { // Unikaj wysyłania bloku do samego siebie
            await sendBlockToPeer(peer, block);
        }
    });

    await Promise.all(broadcastPromises);
};


// Funkcja do broadcastowania nowego node'a do wszystkich peerów
const broadcastNewNode = async (newNodeAddress: string): Promise<void> => {
    const broadcastPromises = Array.from(peers).map(async (peer) => {
        try {
            // Unikaj broadcastowania do samego siebie
            if (peer !== newNodeAddress && peer !== nodeAddress) {
                await axios.post(`${peer}/register_node`, { node_address: newNodeAddress });
                console.log(`Nowy node broadcastowany do peer ${peer}`);
            }
        } catch (error: any) {
            console.log(`Nie można broadcastować node'a do peer ${peer}: ${error.message}`);
        }
    });

    await Promise.all(broadcastPromises);
};

// Funkcja kopiąca
const startMining = async (): Promise<void> => {
    if (miningInProgress) {
        console.log('Kopanie już trwa.');
        return;
    }
    miningInProgress = true;

    try {
        console.log('Rozpoczynam kopanie nowego bloku...');

        while (blockchain.unconfirmedTransactions.length > 0) {
            const lastBlock = blockchain.getLastBlock();
            const newBlock = new Block(
                lastBlock.index + 1,
                blockchain.unconfirmedTransactions.slice(),
                lastBlock.hash
            );

            let miningInterrupted = false;

            // Funkcja obsługująca przerwanie kopania
            const onMiningInterrupted = () => {
                miningInterrupted = true;
            };

            eventEmitter.once('newBlock', onMiningInterrupted);
            eventEmitter.once('newTransaction', onMiningInterrupted);

            const proof = await proofOfWorkAsync(newBlock, () => miningInterrupted);

            eventEmitter.off('newBlock', onMiningInterrupted);
            eventEmitter.off('newTransaction', onMiningInterrupted);

            if (miningInterrupted) {
                console.log('Kopanie przerwane. Restart kopania z nowymi danymi.');
                continue; // Restart kopania z nowymi transakcjami
            }

            if (proof && blockchain.addBlock(newBlock, proof)) {
                console.log(`Blok #${newBlock.index} został pomyślnie dodany do łańcucha.`);

                // Broadcast nowego bloku
                const blockToBroadcast: BlockData = { ...newBlock.toDict(), hash: newBlock.hash };
                console.log(`Blok #${newBlock.index} został dodany do łańcucha i broadcastowany.`);
                await broadcastBlock(blockToBroadcast);

                // Emitowanie zdarzenia nowego bloku
                eventEmitter.emit('newBlock');
            } else {
                console.log('Dodanie bloku do łańcucha nie powiodło się.');
            }
        }
    } catch (error: any) {
        console.log(`Błąd podczas kopania: ${error.message}`);
    }

    miningInProgress = false;
};

// Funkcja proofOfWorkAsync
const proofOfWorkAsync = async (block: Block, stopMining: () => boolean): Promise<string | null> => {
    block.nonce = 0;
    let computedHash = block.computeHash();
    const target = '0'.repeat(blockchain.difficulty);
    while (!computedHash.startsWith(target)) {
        if (stopMining()) {
            return null; // Kopanie zostało przerwane
        }
        block.nonce += 1;
        // if (block.nonce % 1000 === 0) {
        //     // console.log('Nonce:', block.nonce);
        //     // Dodaj małe opóźnienie, aby nie blokować event loopa
        //     await new Promise(resolve => setImmediate(resolve));
        // }
        computedHash = block.computeHash();
    }
    console.log('Nonce znaleziony:', block.nonce);
    return computedHash;
};

// Funkcja do rejestracji u wszystkich peerów początkowych
const registerWithPeers = async (): Promise<void> => {
    console.log('Peers:', initialPeerAddresses);
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

// Handler do aktualizacji listy aktywnych minerów
const updateActiveMinersHandler: RequestHandler = async (req: Request, res: Response): Promise<void> => {
    const newActiveMiners: string[] = req.body.activeMiners;
    if (!newActiveMiners || !Array.isArray(newActiveMiners)) {
        res.status(400).send('Nieprawidłowe dane aktywnych minerów');
        return;
    }

    newActiveMiners.forEach(miner => {
        if (miner !== nodeAddress) { // Unikaj dodawania samego siebie
            peers.add(miner);
        }
    });
    console.log('Aktualizacja listy aktywnych minerów:', peers);

    res.status(200).send('Lista aktywnych minerów zaktualizowana');
};
app.post('/active_miners', updateActiveMinersHandler);

// Funkcja do broadcastowania aktywnych minerów do wszystkich peerów
const broadcastActiveMiners = async (): Promise<void> => {
    const broadcastPromises = Array.from(peers).map(async (peer) => {
        try {
            // Unikaj wysyłania do samego siebie
            if (peer !== nodeAddress) {
                await axios.post(`${peer}/active_miners`, { activeMiners: Array.from(peers) });
            }
        } catch (error: any) {
            console.log(`Nie można broadcastować aktywnych minerów do peer ${peer}: ${error.message}`);
        }
    });

    await Promise.all(broadcastPromises);
};

// Harmonogram synchronizacji co 10 sekund
const scheduleActiveMinersSynchronization = () => {
    setInterval(async () => {
        await broadcastActiveMiners();
    }, 10000); // 10 000 ms = 10 sekund
};


// Uruchomienie serwera i minera
const start = async () => {
    await registerWithPeers();

    // Jeśli są niepotwierdzone transakcje, rozpocznij kopanie
    if (blockchain.unconfirmedTransactions.length > 0) {
        startMining();
    }

    scheduleActiveMinersSynchronization();
};

start();

// Start serwera Express
app.listen(PORT, () => {
    console.log(`Node działa na porcie ${PORT}`);
});
