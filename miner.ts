// src/miner.ts

import axios, { AxiosResponse } from 'axios';
import {BlockData} from "./blockchain";

export const nodeAddress: string | undefined = process.argv[2];
export const peerAddresses: string[] = process.argv.slice(3);

if (!nodeAddress) {
    console.log('Użycie: node miner.js <NODE_ADDRESS> [PEER_ADDRESS1 PEER_ADDRESS2 ...]');
    process.exit(1);
}

let shouldMine: boolean = true; // Flaga kontrolująca kopanie

// Rejestracja węzła u peerów
const registerWithPeers = async (): Promise<void> => {
    for (const peer of peerAddresses) {
        try {
            await axios.post(`${peer}/register_node`, { node_address: nodeAddress });
            console.log(`Zarejestrowano node'a w peer ${peer}`);
        } catch (error: any) {
            console.log(`Nie można zarejestrować node'a w peer ${peer}: ${error.message}`);
        }
    }
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

const mine = async (): Promise<void> => {
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

// Uruchomienie procesów
const start = async () => {
    await registerWithPeers();
    // Uruchomienie kopania i monitorowania w równoległych procesach
    mine();
    monitorChain();
};

start();
