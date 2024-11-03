// src/blockchain.ts

import { Block, Transaction } from './block';
import * as crypto from 'crypto';
import axios, { AxiosResponse } from 'axios';

export interface BlockData {
    index: number;
    timestamp: number;
    transactions: Transaction[];
    previousHash: string;
    nonce: number;
    hash: string;
}

export class Blockchain {
    chain: Block[];
    unconfirmedTransactions: Transaction[];
    difficulty: number;

    processedTransactions: Set<string>;
    processedBlocks: Set<string>;

    constructor() { // Domyślna trudność to 5
        this.chain = [];
        this.unconfirmedTransactions = [];
        this.difficulty = 5;

        this.processedTransactions = new Set<string>();
        this.processedBlocks = new Set<string>();

        this.createGenesisBlock();
    }

    createGenesisBlock(): void {
        const genesisBlock = new Block(0, [], "0", 0, 0);
        genesisBlock.hash = genesisBlock.computeHash(); // Upewnij się, że hash jest obliczony
        this.chain.push(genesisBlock);
        this.processedBlocks.add(genesisBlock.hash);
        console.log('Genesis Block:', genesisBlock.toDict());
    }

    getLastBlock(): Block {
        return this.chain[this.chain.length - 1];
    }

    addTransaction(transaction: Transaction): void {
        const txHash = this.computeTransactionHash(transaction);
        if (!this.processedTransactions.has(txHash)) {
            this.unconfirmedTransactions.push(transaction);
            this.processedTransactions.add(txHash);
        }
    }

    computeTransactionHash(transaction: Transaction): string {
        return crypto.createHash('sha256').update(JSON.stringify(transaction)).digest('hex');
    }

    proofOfWork(block: Block): string {
        block.nonce = 0;
        let computedHash = block.computeHash();
        const target = '0'.repeat(this.difficulty);
        while (!computedHash.startsWith(target)) {
            block.nonce += 1;
            // Log nonce co 1000 iteracji to avoid flooding logs
            if (block.nonce % 1000 === 0) {
                console.log('Nonce:', block.nonce);
            }
            computedHash = block.computeHash();
        }
        console.log('Nonce:', block.nonce);
        return computedHash;
    }

    addBlock(block: Block, proof: string): boolean {
        const lastBlock = this.getLastBlock();

        if (lastBlock.hash !== block.previousHash) {
            console.log('Nieprawidłowy poprzedni hash');
            return false;
        }

        // Sprawdzenie, czy blok z tym samym previousHash już istnieje
        const existingBlock = this.chain.find(b => b.previousHash === block.previousHash && b.hash !== block.hash);
        if (existingBlock) {
            console.log('Blok z tym poprzednim hashem już istnieje');
            return false;
        }

        if (!this.isValidProof(block, proof)) {
            console.log('Nieprawidłowy dowód pracy');
            return false;
        }

        block.hash = proof;
        this.chain.push(block);
        console.log('Dodano nowy blok:', block.toDict());
        this.processedBlocks.add(block.hash);

        // Dodanie transakcji do processedTransactions i usunięcie ich z unconfirmedTransactions
        block.transactions.forEach(tx => {
            const txHash = this.computeTransactionHash(tx);
            this.processedTransactions.add(txHash);
            // Usunięcie transakcji z unconfirmedTransactions, jeśli istnieje
            this.unconfirmedTransactions = this.unconfirmedTransactions.filter(utx => this.computeTransactionHash(utx) !== txHash);
        });

        return true;
    }

    isValidProof(block: Block, blockHash: string): boolean {
        const target = '0'.repeat(this.difficulty);
        return (
            blockHash.startsWith(target) &&
            blockHash === block.computeHash()
        );
    }

    mine(): number | false {
        if (this.unconfirmedTransactions.length === 0) {
            return false;
        }

        const lastBlock = this.getLastBlock();
        const newBlock = new Block(
            lastBlock.index + 1,
            this.unconfirmedTransactions,
            lastBlock.hash
        );
        const proof = this.proofOfWork(newBlock);

        if (this.addBlock(newBlock, proof)) {
            this.unconfirmedTransactions = [];
            return newBlock.index;
        }
        return false;
    }

    getChain(): BlockData[] {
        return this.chain.map(block => block.toDict());
    }

    logChain(blockchain: BlockData[]): void {
        console.log('\n\nBlockchain:', JSON.stringify(blockchain, null, 2), '\n\n');
    }

    isValidChain(chain: BlockData[]): boolean {
        if (chain.length === 0) return false;
        if (chain[0].previousHash !== "0") return false;
        for (let i = 1; i < chain.length; i++) {
            const currentBlock = chain[i];
            const previousBlock = chain[i - 1];
            if (currentBlock.previousHash !== previousBlock.hash) {
                console.log(`Blok #${currentBlock.index} ma nieprawidłowy previousHash.`);
                return false;
            }
            if (currentBlock.hash !== this.calculateHash(currentBlock)) {
                console.log(`Blok #${currentBlock.index} ma nieprawidłowy hash.`);
                return false;
            }
            if (!currentBlock.hash.startsWith('0'.repeat(this.difficulty))) {
                console.log(`Blok #${currentBlock.index} nie spełnia wymagań trudności.`);
                return false;
            }
        }
        return true;
    }

    calculateHash(block: BlockData): string {
        const blockString = JSON.stringify({
            index: block.index,
            timestamp: block.timestamp,
            transactions: block.transactions,
            previousHash: block.previousHash,
            nonce: block.nonce
        });
        return crypto.createHash('sha256').update(blockString).digest('hex');
    }

    async resolveConflicts(peers: string[]): Promise<boolean> {
        console.log('Rozwiązywanie konfliktów...');

        let newChain: BlockData[] | null = null;
        let maxLength: number = this.chain.length;
        let minHashValue: number | null = null;

        for (const peer of peers) {
            try {
                const response: AxiosResponse = await axios.get<BlockData[]>(`${peer}/chain`);
                const chain = response.data;
                if (this.isValidChain(chain)) {
                    const currentChainLength = chain.length;
                    const lastBlock = chain[currentChainLength - 1];
                    const hashValue = parseInt(lastBlock.hash, 16);

                    if (currentChainLength > maxLength) {
                        // Jeśli łańcuch jest dłuższy, wybierz go
                        maxLength = currentChainLength;
                        minHashValue = hashValue;
                        newChain = chain;
                    } else if (currentChainLength === maxLength) {
                        // Jeśli łańcuch ma tę samą długość, wybierz ten z mniejszym hashem
                        if (minHashValue === null || hashValue < minHashValue) {
                            minHashValue = hashValue;
                            newChain = chain;
                        }
                    }
                }
            } catch (error: any) {
                console.log(`Błąd podczas pobierania łańcucha z peer ${peer}: ${error.message}`);
            }
        }

        if (newChain) {
            const newChainLastHash = parseInt(newChain[newChain.length - 1].hash, 16);
            const currentLastHash = parseInt(this.getLastBlock().hash, 16);

            if (newChain.length > this.chain.length ||
                (newChain.length === this.chain.length && newChainLastHash < currentLastHash)) {
                this.chain = newChain.map(blockData => {
                    const block = new Block(
                        blockData.index,
                        blockData.transactions,
                        blockData.previousHash,
                        blockData.nonce,
                        blockData.timestamp
                    );
                    block.hash = blockData.hash;
                    this.processedBlocks.add(block.hash);
                    block.transactions.forEach(tx => {
                        const txHash = this.computeTransactionHash(tx);
                        this.processedTransactions.add(txHash);
                        // Usunięcie transakcji z unconfirmedTransactions, jeśli istnieje
                        this.unconfirmedTransactions = this.unconfirmedTransactions.filter(utx => this.computeTransactionHash(utx) !== txHash);
                    });
                    return block;
                });
                console.log('Łańcuch został zastąpiony nowym, dłuższym łańcuchem.');
                return true;
            }
        }

        return false;
    }
}
