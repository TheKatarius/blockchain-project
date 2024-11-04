// src/node.ts

// Importowanie niezbędnych modułów i typów
import express, { Request, Response, Application, RequestHandler } from 'express';
import bodyParser from 'body-parser';
import axios, { AxiosResponse } from 'axios';
import { Blockchain, BlockData } from './blockchain';
import { Block, Transaction } from './block';
import { EventEmitter } from 'events';

// Utworzenie instancji EventEmitter do zarządzania zdarzeniami w aplikacji
const eventEmitter = new EventEmitter();

// Ustawienie serwera Express
const app: Application = express();

// Middleware do parsowania JSON z limitem rozmiaru 10 MB
app.use(bodyParser.json({ limit: '10mb' }));

// Pobranie argumentów z wiersza poleceń:
// - process.argv[2]: numer portu, na którym ma działać node
// - process.argv.slice(3): początkowe adresy peerów, do których node się łączy
const PORT: number = parseInt(process.argv[2], 10) || 5000;
const initialPeerAddresses: string[] = process.argv.slice(3);

// Zdefiniowanie adresu node na podstawie numeru portu
const nodeAddress: string = `http://localhost:${PORT}`;

// Inicjalizacja instancji Blockchain z określoną trudnością
const DIFFICULTY: number = 6; // Możesz zmienić wartość trudności
const blockchain = new Blockchain(DIFFICULTY);

// Zestaw przechowujący adresy peerów (inna sieć node'ów w blockchainie)
const peers: Set<string> = new Set();

// Dodanie początkowych peerów do zestawu, jeśli zostały podane
initialPeerAddresses.forEach(peer => {
    if (peer !== nodeAddress) { // Unikaj dodawania samego siebie jako peer
        peers.add(peer);
    }
});

// Flaga kontrolująca, czy kopanie (mining) jest w trakcie
let miningInProgress: boolean = false;

/**
 * Handler dla endpointu /new_transaction
 * Odbiera nowe transakcje, weryfikuje ich poprawność, dodaje do listy niepotwierdzonych transakcji
 * oraz broadcastuje je do innych peerów.
 */
const newTransactionHandler: RequestHandler = async (req: Request, res: Response): Promise<void> => {
    console.log('Otrzymano żądanie /new_transaction:', req.body);

    // Wyodrębnienie transakcji z treści żądania
    const transaction: Transaction = req.body;

    // Definicja wymaganych pól w transakcji
    const requiredFields: string[] = ['author', 'content'];

    // Sprawdzenie, czy transakcja zawiera wszystkie wymagane pola
    if (!transaction || !requiredFields.every(field => transaction.hasOwnProperty(field))) {
        res.status(400).send('Nieprawidłowe dane transakcji');
        return;
    }

    // Sprawdzenie, czy transakcja została już przetworzona, aby uniknąć duplikacji
    if (blockchain.isTransactionProcessed(transaction)) {
        console.log('Transakcja już została przetworzona, pomijam broadcast.');
        res.status(200).send('Transakcja już została przetworzona');
        return;
    }

    // Dodanie transakcji do listy niepotwierdzonych transakcji w blockchainie
    blockchain.addTransaction(transaction);

    // Broadcastowanie transakcji do wszystkich peerów w sieci
    await broadcastTransaction(transaction);

    // Emitowanie zdarzenia nowej transakcji, co może uruchomić proces kopania
    eventEmitter.emit('newTransaction');

    // Rozpoczęcie kopania, jeśli kopanie nie jest już w trakcie
    if (!miningInProgress) {
        startMining();
    }

    // Odpowiedź z informacją, że transakcja została dodana
    res.status(201).send('Transakcja dodana');
};

// Rejestracja handlera dla endpointu POST /new_transaction
app.post('/new_transaction', newTransactionHandler);

/**
 * Handler dla endpointu GET /chain
 * Zwraca cały łańcuch bloków jako odpowiedź w formacie JSON.
 */
const getChainHandler: RequestHandler = (req: Request, res: Response): void => {
    // Logowanie całego łańcucha bloków w konsoli (przydatne do debugowania)
    blockchain.logChain(blockchain.getChain());

    // Zwrócenie łańcucha bloków jako odpowiedź JSON
    res.json(blockchain.getChain());
};

// Rejestracja handlera dla endpointu GET /chain
app.get('/chain', getChainHandler);

/**
 * Handler dla endpointu POST /register_node
 * Służy do rejestracji nowego node'a w sieci. Dodaje nowy adres do zestawu peerów,
 * broadcastuje go do innych peerów oraz wysyła lokalny łańcuch bloków do nowego node'a.
 */
const registerNodeHandler: RequestHandler = async (req: Request, res: Response): Promise<void> => {
    // Pobranie adresu nowego node'a z treści żądania
    const newNodeAddress: string = req.body.node_address;

    // Sprawdzenie, czy adres node'a został dostarczony
    if (!newNodeAddress) {
        res.status(400).send('Nieprawidłowe dane');
        return;
    }

    // Sprawdzenie, czy nowy node nie jest samym sobą
    if (newNodeAddress === nodeAddress) {
        res.status(400).send('Nie można zarejestrować samego siebie');
        return;
    }

    // Dodanie nowego node'a do zestawu peerów, jeśli nie jest już zarejestrowany
    if (!peers.has(newNodeAddress)) {
        peers.add(newNodeAddress);
        console.log('Peers:', peers);
        console.log(`Nowy node zarejestrowany: ${newNodeAddress}`);

        // Broadcastowanie nowego node'a do wszystkich istniejących peerów
        await broadcastNewNode(newNodeAddress);

        // Jeśli lokalny łańcuch bloków zawiera więcej niż jeden blok (czyli Genesis Block + inne), wysyłamy go do nowego node'a
        if(blockchain.getChain().length > 1) {
            try {
                await axios.post(`${newNodeAddress}/replace_chain`, { newChain: blockchain.getChain() });
                console.log(`Wysłano łańcuch do nowego node'a ${newNodeAddress}`);
            } catch (error: any) {
                console.log(`Nie można wysłać łańcucha do nowego node'a ${newNodeAddress}: ${error.message}`);
            }
        }
    } else {
        console.log(`Node ${newNodeAddress} już jest zarejestrowany`);
    }

    // Zwrócenie lokalnego łańcucha bloków jako odpowiedź
    res.json({ chain: blockchain.getChain() }); // Upewnij się, że zwracasz łańcuch w odpowiednim formacie
};

// Rejestracja handlera dla endpointu POST /register_node
app.post('/register_node', registerNodeHandler);

/**
 * Handler dla endpointu POST /add_block
 * Służy do dodawania nowego bloku do łańcucha bloków. Sprawdza, czy blok jest już przetworzony,
 * próbuje go dodać do lokalnego łańcucha, a w przypadku niepowodzenia (konfliktu) próbuje rozwiązać konflikt.
 */
const addBlockHandler: RequestHandler = async (req: Request, res: Response): Promise<void> => {
    try {
        console.log('Otrzymano żądanie /add_block:', req.body);

        // Pobranie danych bloku z treści żądania
        const blockData: BlockData = req.body;

        console.log(blockchain.processedBlocks);

        // Sprawdzenie, czy blok został już przetworzony (na podstawie jego hash'u)
        if (blockchain.processedBlocks.has(blockData.hash)) {
            console.log('Blok już został przetworzony, pomijam.');
            res.status(200).send('Blok już został przetworzony');
            return;
        }

        // Tworzenie instancji klasy Block na podstawie danych z żądania
        const newBlock = new Block(
            blockData.index,
            blockData.transactions,
            blockData.previousHash,
            blockData.nonce,
            blockData.timestamp
        );
        newBlock.hash = blockData.hash; // Ustawienie hash'u bloku na hash przesłany w żądaniu

        // Próba dodania bloku do lokalnego łańcucha
        const added: boolean = blockchain.addBlock(newBlock, newBlock.hash);
        if (!added) {
            // Jeśli dodanie się nie powiodło, prawdopodobnie wystąpił konflikt. Próba rozwiązania konfliktu.
            // Jednak w poprzednich krokach zdecydowaliśmy, że nie będziemy rozwiązywać konfliktów w tym przypadku,
            // więc możesz pominąć ten fragment, ale tutaj pozostawiam go jako przykład.
            // const resolved: boolean = await blockchain.resolveConflicts(Array.from(peers));
            // if (resolved) {
            //     console.log('Łańcuch został zastąpiony po konflikcie.');
            //     res.status(201).send('Łańcuch został zastąpiony');
            //
            //     // Emitowanie zdarzenia nowego bloku
            //     eventEmitter.emit('newBlock');
            //     return;
            // } else {
            //     console.log('Blok odrzucony po uwzględnieniu rozwiązywania konfliktów.');
            //     res.status(400).send('Blok odrzucony');
            //     return;
            // }

            // Jeśli nie rozwiązujemy konfliktów, po prostu odrzucamy blok
            console.log('Blok odrzucony z powodu konfliktu z istniejącym blokiem.');
            res.status(400).send('Blok odrzucony z powodu konfliktu.');
            return;
        } else {
            // Jeśli blok został pomyślnie dodany, broadcastujemy go do wszystkich peerów
            const blockToBroadcast: BlockData = { ...newBlock.toDict(), hash: newBlock.hash };
            console.log(`Blok #${newBlock.index} został dodany do łańcucha i broadcastowany.`);

            // Broadcastowanie bloku do wszystkich peerów
            await broadcastBlock(blockToBroadcast);

            // Emitowanie zdarzenia nowego bloku, co może uruchomić proces kopania w innych node'ach
            eventEmitter.emit('newBlock');

            // Odpowiedź z informacją, że blok został dodany
            res.status(201).send('Blok dodany do łańcucha');
        }
    } catch (error: any) {
        // Obsługa błędów podczas przetwarzania żądania
        console.error('Błąd podczas przetwarzania /add_block:', error);
        res.status(500).send('Internal Server Error');
    }
};

// Rejestracja handlera dla endpointu POST /add_block
app.post('/add_block', addBlockHandler);

/**
 * Funkcja broadcastTransaction
 * Broadcastuje transakcję do wszystkich peerów w sieci poprzez endpoint /new_transaction.
 * Unika wysyłania transakcji do samego siebie.
 * @param transaction - Transakcja do broadcastowania
 */
const broadcastTransaction = async (transaction: Transaction): Promise<void> => {
    // Tworzenie tablicy obietnic dla każdej operacji broadcastowania
    const broadcastPromises = Array.from(peers).map(async (peer) => {
        try {
            // Unikaj wysyłania transakcji do samego siebie
            if (peer !== nodeAddress) {
                await axios.post(`${peer}/new_transaction`, transaction);
                console.log(`Transakcja broadcastowana do peer ${peer}`);
            }
        } catch (error: any) {
            // Obsługa błędów podczas broadcastowania transakcji
            console.log(`Nie można wysłać transakcji do peer ${peer}: ${error.message}`);
        }
    });

    // Czekanie na zakończenie wszystkich operacji broadcastowania
    await Promise.all(broadcastPromises);
};

/**
 * Funkcja sendBlockToPeer
 * Próbuje wysłać blok do danego peer'a poprzez endpoint /add_block.
 * W przypadku niepowodzenia (np. blok już przetworzony) przerywa próbę.
 * W przeciwnym razie próbuje ponownie po 1 sekundzie.
 * @param peer - Adres peer'a, do którego wysyłamy blok
 * @param block - Blok do wysłania
 */
const sendBlockToPeer = async (peer: string, block: BlockData): Promise<void> => {
    while (true) { // Pętla próbująca wysłać blok
        try {
            await axios.post(`${peer}/add_block`, block);
            console.log(`Blok broadcastowany do peer ${peer}`);
            break; // Wyjście z pętli, jeśli wysyłka się powiodła
        } catch (error: any) {
            if(error.response && error.response.status === 400) {
                // Jeśli peer odrzucił blok (np. już został przetworzony), przerywamy próbę
                console.log(`Blok został już przetworzony przez peer ${peer} i rozwiązał konflikty`);
                break;
            }
            // W przeciwnym razie, logujemy błąd i czekamy 1 sekundę przed ponowną próbą
            console.log(`Nie można wysłać bloku do peer ${peer}: ${error.message}. Retrying in 1 second...`);
            await new Promise(resolve => setTimeout(resolve, 1000)); // Poczekaj 1 sekundę
        }
    }
};

/**
 * Funkcja broadcastBlock
 * Broadcastuje blok do wszystkich peerów w sieci poprzez endpoint /add_block.
 * Unika wysyłania bloku do samego siebie.
 * @param block - Blok do broadcastowania
 */
const broadcastBlock = async (block: BlockData): Promise<void> => {
    console.log('Peers:', peers);

    // Tworzenie tablicy obietnic dla każdej operacji broadcastowania
    const broadcastPromises = Array.from(peers).map(async (peer) => {
        if (peer !== nodeAddress) { // Unikaj wysyłania bloku do samego siebie
            await sendBlockToPeer(peer, block);
        }
    });

    // Czekanie na zakończenie wszystkich operacji broadcastowania
    await Promise.all(broadcastPromises);
};

/**
 * Funkcja broadcastNewNode
 * Broadcastuje adres nowego node'a do wszystkich peerów w sieci poprzez endpoint /register_node.
 * Unika broadcastowania do samego siebie oraz do nowego node'a, który właśnie się zarejestrował.
 * @param newNodeAddress - Adres nowego node'a do broadcastowania
 */
const broadcastNewNode = async (newNodeAddress: string): Promise<void> => {
    // Tworzenie tablicy obietnic dla każdej operacji broadcastowania
    const broadcastPromises = Array.from(peers).map(async (peer) => {
        try {
            // Unikaj broadcastowania do samego siebie oraz do nowego node'a
            if (peer !== newNodeAddress && peer !== nodeAddress) {
                await axios.post(`${peer}/register_node`, { node_address: newNodeAddress });
                console.log(`Nowy node broadcastowany do peer ${peer}`);
            }
        } catch (error: any) {
            // Obsługa błędów podczas broadcastowania nowego node'a
            console.log(`Nie można broadcastować node'a do peer ${peer}: ${error.message}`);
        }
    });

    // Czekanie na zakończenie wszystkich operacji broadcastowania
    await Promise.all(broadcastPromises);
};

/**
 * Funkcja startMining
 * Inicjuje proces kopania nowego bloku, jeśli kopanie nie jest już w trakcie.
 * Monitoruje zdarzenia (nowy blok lub nowa transakcja), aby przerwać kopanie w razie potrzeby.
 */
const startMining = async (): Promise<void> => {
    // Sprawdzenie, czy kopanie już trwa
    if (miningInProgress) {
        console.log('Kopanie już trwa.');
        return;
    }
    miningInProgress = true; // Ustawienie flagi, że kopanie jest w trakcie

    try {
        console.log('Rozpoczynam kopanie nowego bloku...');

        // Pętla kopiąca, działa, dopóki są niepotwierdzone transakcje
        while (blockchain.unconfirmedTransactions.length > 0) {
            const lastBlock = blockchain.getLastBlock(); // Pobranie ostatniego bloku w łańcuchu
            const newBlock = new Block(
                lastBlock.index + 1,                      // Ustawienie indeksu nowego bloku
                blockchain.unconfirmedTransactions.slice(), // Kopiowanie niepotwierdzonych transakcji
                lastBlock.hash                            // Ustawienie poprzedniego hash'u na hash ostatniego bloku
            );

            let miningInterrupted = false; // Flaga wskazująca, czy kopanie zostało przerwane

            /**
             * Funkcja obsługująca przerwanie kopania.
             * Jest wywoływana, gdy nastąpi zdarzenie 'newBlock' lub 'newTransaction'.
             */
            const onMiningInterrupted = () => {
                miningInterrupted = true;
            };

            // Nasłuchiwanie na zdarzenia, które mogą przerwać kopanie
            eventEmitter.once('newBlock', onMiningInterrupted);
            eventEmitter.once('newTransaction', onMiningInterrupted);

            // Wykonanie Proof of Work w trybie asynchronicznym
            const proof = await proofOfWorkAsync(newBlock, () => miningInterrupted);

            // Usunięcie nasłuchiwaczy zdarzeń po zakończeniu kopania
            eventEmitter.off('newBlock', onMiningInterrupted);
            eventEmitter.off('newTransaction', onMiningInterrupted);

            // Jeśli kopanie zostało przerwane, restartujemy proces z nowymi danymi
            if (miningInterrupted) {
                console.log('Kopanie przerwane. Restart kopania z nowymi danymi.');
                continue; // Kontynuowanie pętli kopiącej z nowymi transakcjami
            }

            // Jeśli Proof of Work zakończył się sukcesem i blok został dodany do łańcucha
            if (proof && blockchain.addBlock(newBlock, proof)) {
                console.log(`Blok #${newBlock.index} został pomyślnie dodany do łańcucha.`);

                // Przygotowanie bloku do broadcastowania
                const blockToBroadcast: BlockData = { ...newBlock.toDict(), hash: newBlock.hash };
                console.log(`Blok #${newBlock.index} został dodany do łańcucha i broadcastowany.`);

                // Broadcastowanie nowego bloku do wszystkich peerów
                await broadcastBlock(blockToBroadcast);

                // Emitowanie zdarzenia nowego bloku
                eventEmitter.emit('newBlock');
            } else {
                console.log('Dodanie bloku do łańcucha nie powiodło się.');
            }
        }
    } catch (error: any) {
        // Obsługa błędów podczas kopania
        console.log(`Błąd podczas kopania: ${error.message}`);
    }

    miningInProgress = false; // Ustawienie flagi, że kopanie się zakończyło
};

/**
 * Funkcja proofOfWorkAsync
 * Wykonuje Proof of Work dla danego bloku w trybie asynchronicznym.
 * Przerwanie kopania jest możliwe poprzez wywołanie funkcji stopMining.
 * @param block - Blok, dla którego wykonujemy Proof of Work
 * @param stopMining - Funkcja, która zwraca true, jeśli kopanie ma zostać przerwane
 * @returns Obliczony hash spełniający wymagania trudności lub null, jeśli kopanie zostało przerwane
 */
const proofOfWorkAsync = async (block: Block, stopMining: () => boolean): Promise<string | null> => {
    block.nonce = 0; // Inicjalizacja nonce na 0
    let computedHash = block.computeHash(); // Obliczenie początkowego hash'u bloku
    const target = '0'.repeat(blockchain.difficulty); // Definiowanie targetu na podstawie trudności (np. '000000' dla trudności 6)

    // Pętla do znalezienia odpowiedniego hash'u
    while (!computedHash.startsWith(target)) {
        // Sprawdzenie, czy kopanie ma zostać przerwane
        if (stopMining()) {
            return null; // Kopanie zostało przerwane
        }
        block.nonce += 1; // Zwiększenie nonce
        // Opcjonalnie, logowanie nonce co 1000 iteracji, aby nie zalewać logów
        // if (block.nonce % 1000 === 0) {
        //     console.log('Nonce:', block.nonce);
        //     // Dodaj małe opóźnienie, aby nie blokować event loopa
        //     await new Promise(resolve => setImmediate(resolve));
        // }
        computedHash = block.computeHash(); // Ponowne obliczenie hash'u z nowym nonce
    }
    console.log('Nonce znaleziony:', block.nonce); // Logowanie znalezionego nonce
    return computedHash; // Zwrócenie obliczonego hash'u
};

/**
 * Funkcja registerWithPeers
 * Rejestruje lokalny node wśród początkowych peerów podanych podczas uruchomienia.
 * Wysyła żądanie POST /register_node do każdego z początkowych peerów z adresem lokalnego node'a.
 */
const registerWithPeers = async (): Promise<void> => {
    console.log('Peers:', initialPeerAddresses);
    for (const peer of initialPeerAddresses) {
        if (peer !== nodeAddress) { // Unikaj rejestracji samego siebie
            try {
                // Wysyłanie żądania rejestracji lokalnego node'a do peer'a
                await axios.post(`${peer}/register_node`, { node_address: nodeAddress });
                console.log(`Zarejestrowano node'a w peer ${peer}`);
            } catch (error: any) {
                // Obsługa błędów podczas rejestracji
                console.log(`Nie można zarejestrować node'a w peer ${peer}: ${error.message}`);
            }
        }
    }
};

/**
 * Handler dla endpointu POST /replace_chain
 * Służy do zastąpienia lokalnego łańcucha bloków nowym łańcuchem, jeśli jest on ważny i dłuższy.
 * Jest używany podczas synchronizacji łańcucha bloków między node'ami.
 */
const replaceChainHandler: RequestHandler = async (req: Request, res: Response): Promise<void> => {
    // Pobranie nowego łańcucha bloków z treści żądania
    const newChain: BlockData[] = req.body.newChain;

    // Weryfikacja, czy nowy łańcuch został przesłany i jest tablicą
    if (!newChain || !Array.isArray(newChain)) {
        res.status(400).send('Nieprawidłowy nowy łańcuch');
        return;
    }

    // Sprawdzenie, czy nowy łańcuch jest ważny i dłuższy niż lokalny łańcuch
    if (blockchain.isValidChain(newChain) && newChain.length > blockchain.chain.length) {
        // Zastąpienie lokalnego łańcucha nowym łańcuchem
        blockchain.replaceChain(newChain);
        console.log('Lokalny łańcuch został zastąpiony nowym, dłuższym łańcuchem.');

        // Broadcastowanie nowego łańcucha do wszystkich peerów
        await broadcastChain();

        // Odpowiedź z informacją, że łańcuch został zastąpiony
        res.status(200).send('Łańcuch został zastąpiony');
    } else {
        // Jeśli nowy łańcuch jest nieprawidłowy lub krótszy, odrzucamy żądanie
        res.status(400).send('Nowy łańcuch jest nieprawidłowy lub krótszy');
    }
};

// Rejestracja handlera dla endpointu POST /replace_chain
app.post('/replace_chain', replaceChainHandler);

/**
 * Funkcja broadcastChain
 * Broadcastuje cały lokalny łańcuch bloków do wszystkich peerów w sieci poprzez endpoint /replace_chain.
 * @returns Promise<void>
 */
const broadcastChain = async (): Promise<void> => {
    const chain = blockchain.getChain(); // Pobranie całego lokalnego łańcucha bloków

    // Tworzenie tablicy obietnic dla każdej operacji broadcastowania
    const broadcastPromises = Array.from(peers).map(async (peer) => {
        try {
            // Wysyłanie żądania POST /replace_chain do peer'a z lokalnym łańcuchem bloków
            await axios.post(`${peer}/replace_chain`, { newChain: chain });
            console.log(`Łańcuch broadcastowany do peer ${peer}`);
        } catch (error: any) {
            // Obsługa błędów podczas broadcastowania łańcucha
            console.log(`Nie można broadcastować łańcucha do peer ${peer}: ${error.message}`);
        }
    });

    // Czekanie na zakończenie wszystkich operacji broadcastowania
    await Promise.all(broadcastPromises);
};

/**
 * Handler dla endpointu POST /active_miners
 * Służy do aktualizacji listy aktywnych minerów w lokalnym node'ie.
 * Przyjmuje listę aktywnych minerów i dodaje ich do zestawu peerów.
 */
const updateActiveMinersHandler: RequestHandler = async (req: Request, res: Response): Promise<void> => {
    // Pobranie listy aktywnych minerów z treści żądania
    const newActiveMiners: string[] = req.body.activeMiners;

    // Sprawdzenie, czy lista aktywnych minerów została dostarczona i jest tablicą
    if (!newActiveMiners || !Array.isArray(newActiveMiners)) {
        res.status(400).send('Nieprawidłowe dane aktywnych minerów');
        return;
    }

    // Dodanie każdego minera do zestawu peerów, unikając dodania samego siebie
    newActiveMiners.forEach(miner => {
        if (miner !== nodeAddress) { // Unikaj dodawania samego siebie
            peers.add(miner);
        }
    });
    console.log('Aktualizacja listy aktywnych minerów:', peers);

    // Odpowiedź z informacją, że lista aktywnych minerów została zaktualizowana
    res.status(200).send('Lista aktywnych minerów zaktualizowana');
};

// Rejestracja handlera dla endpointu POST /active_miners
app.post('/active_miners', updateActiveMinersHandler);

/**
 * Funkcja broadcastActiveMiners
 * Broadcastuje aktualną listę aktywnych minerów do wszystkich peerów w sieci poprzez endpoint /active_miners.
 */
const broadcastActiveMiners = async (): Promise<void> => {
    // Tworzenie tablicy obietnic dla każdej operacji broadcastowania
    const broadcastPromises = Array.from(peers).map(async (peer) => {
        try {
            // Unikaj wysyłania do samego siebie
            if (peer !== nodeAddress) {
                await axios.post(`${peer}/active_miners`, { activeMiners: Array.from(peers) });
            }
        } catch (error: any) {
            // Obsługa błędów podczas broadcastowania aktywnych minerów
            console.log(`Nie można broadcastować aktywnych minerów do peer ${peer}: ${error.message}`);
        }
    });

    // Czekanie na zakończenie wszystkich operacji broadcastowania
    await Promise.all(broadcastPromises);
};

/**
 * Funkcja scheduleActiveMinersSynchronization
 * Harmonogramuje regularne broadcastowanie aktywnych minerów co 10 sekund.
 */
const scheduleActiveMinersSynchronization = () => {
    setInterval(async () => {
        await broadcastActiveMiners();
    }, 10000); // 10 000 ms = 10 sekund
};

/**
 * Funkcja start
 * Inicjalizuje node poprzez rejestrację wśród początkowych peerów, rozpoczyna kopanie, jeśli są niepotwierdzone transakcje,
 * oraz ustawia harmonogram synchronizacji aktywnych minerów.
 */
const start = async () => {
    // Rejestracja lokalnego node'a wśród początkowych peerów
    await registerWithPeers();

    // Jeśli są dostępne niepotwierdzone transakcje, rozpocznij proces kopania
    if (blockchain.unconfirmedTransactions.length > 0) {
        startMining();
    }

    // Ustawienie harmonogramu synchronizacji aktywnych minerów co 10 sekund
    scheduleActiveMinersSynchronization();
};

// Wywołanie funkcji start w celu uruchomienia node'a
start();

// Uruchomienie serwera Express na określonym porcie
app.listen(PORT, () => {
    console.log(`Node działa na porcie ${PORT}`);
});
