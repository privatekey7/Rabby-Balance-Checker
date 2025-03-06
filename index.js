import axios from "axios";
import { Table } from 'console-table-printer';
import { createObjectCsvWriter } from 'csv-writer';
import cliProgress from 'cli-progress';
import fs from 'fs';
import path from 'path';
import { HttpsProxyAgent } from 'https-proxy-agent';

// Утилиты
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function newAbortSignal(timeoutMs) {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), timeoutMs);
  return controller.signal;
}

function readWallets(filePath) {
  try {
    const data = fs.readFileSync(filePath, 'utf8');
    return data.split('\n').map(line => line.trim()).filter(line => line);
  } catch (error) {
    console.error('Ошибка при чтении файла с адресами:', error);
    return [];
  }
}

function readProxies(filePath) {
  try {
    const data = fs.readFileSync(filePath, 'utf8');
    return data.split('\n').map(line => line.trim()).filter(line => line);
  } catch (error) {
    console.error('Ошибка при чтении файла с прокси:', error);
    return [];
  }
}

function getRandomProxy(proxies) {
  if (!proxies || proxies.length === 0) return null;
  const randomIndex = Math.floor(Math.random() * proxies.length);
  return proxies[randomIndex];
}

function createProxyAgent(proxyString) {
  if (!proxyString) return null;
  
  // Формат прокси: http://username:password@host:port или host:port
  let proxyUrl = proxyString;
  if (!proxyString.startsWith('http://') && !proxyString.startsWith('https://')) {
    proxyUrl = `http://${proxyString}`;
  }
  
  return new HttpsProxyAgent(proxyUrl);
}

// Функция для обновления статуса в одной строке
function updateStatus(message) {
  process.stdout.clearLine();
  process.stdout.cursorTo(0);
  process.stdout.write(message);
}

// Основной класс для проверки баланса
class WalletBalanceChecker {
  constructor(walletsFilePath, proxiesFilePath = null) {
    this.walletsFilePath = walletsFilePath;
    this.proxiesFilePath = proxiesFilePath;
    this.wallets = [];
    this.proxies = [];
    this.jsonData = [];
    this.csvData = [];
    this.total = 0;
    this.totalPoints = 0;
    this.progressBar = new cliProgress.SingleBar({}, cliProgress.Presets.shades_classic);
    this.successCount = 0;
    this.failCount = 0;
    
    this.columns = [
      { name: 'n', color: 'green', alignment: "center" },
      { name: 'Wallet', color: 'green', alignment: "center" },
      { name: 'Balance', color: 'green', alignment: "center" },
    ];
    
    this.headers = [
      { id: 'n', title: '№' },
      { id: 'Wallet', title: 'Wallet' },
      { id: 'Balance', title: 'Balance' },
    ];
    
    this.table = new Table({
      columns: this.columns,
      sort: (row1, row2) => +row1.n - +row2.n
    });
    
    this.csvWriter = createObjectCsvWriter({
      path: './wallet-balances.csv',
      header: this.headers,
      fieldDelimiter: ',',
      recordDelimiter: '\n',
      alwaysQuote: true
    });
  }
  
  async init() {
    this.wallets = readWallets(this.walletsFilePath);
    console.log(`Загружено ${this.wallets.length} адресов кошельков`);
    
    if (this.proxiesFilePath) {
      this.proxies = readProxies(this.proxiesFilePath);
      console.log(`Загружено ${this.proxies.length} прокси`);
    }
  }
  
  async fetchWalletBalance(wallet, index) {
    let retryCount = 0;
    const maxRetries = 10; // Увеличиваем количество попыток
    let usedProxies = new Set(); // Отслеживаем использованные прокси
    
    // Сокращенная версия адреса для логов
    const shortWallet = wallet.substring(0, 6) + '...' + wallet.substring(wallet.length - 4);
    
    while (retryCount < maxRetries) {
      try {
        // Выбираем прокси, которое еще не использовали для этого запроса
        let proxyString;
        let attempts = 0;
        const maxProxyAttempts = Math.min(10, this.proxies.length); // Ограничиваем количество попыток выбора прокси
        
        while (attempts < maxProxyAttempts) {
          proxyString = getRandomProxy(this.proxies);
          if (!usedProxies.has(proxyString) || usedProxies.size >= this.proxies.length) {
            break;
          }
          attempts++;
        }
        
        usedProxies.add(proxyString);
        const httpsAgent = proxyString ? createProxyAgent(proxyString) : undefined;
        
        const config = {
          signal: newAbortSignal(30000), // Уменьшаем таймаут для быстрого определения неработающих прокси
          headers: {
            "accept": "application/json, text/plain, */*",
            "accept-language": "en-US,en;q=0.9",
            "priority": "u=1, i",
            "sec-fetch-dest": "empty",
            "sec-fetch-mode": "cors",
            "sec-fetch-site": "none",
            "x-client": "Rabby",
            "x-version": "0.92.72"
          }
        };
        
        if (httpsAgent) {
          config.httpsAgent = httpsAgent;
        }
        
        const response = await axios.get(`https://api.rabby.io/v1/user/total_balance?id=${wallet}`, config);
        
        if (response.data) {
          const totalBalance = parseInt(response.data.total_usd_value);
          const chains = response.data.chain_list;
          
          this.successCount++;
          
          return {
            wallet,
            balance: totalBalance,
            chains
          };
        }
        
        // Если дошли до этой точки без ошибки, но данных нет, увеличиваем счетчик попыток
        retryCount++;
        await sleep(1000);
        
      } catch (error) {
        // Убираем вывод ошибки
        retryCount++;
        
        if (retryCount < maxRetries) {
          await sleep(2000); // Пауза перед повторной попыткой
        }
      }
    }
    
    this.failCount++;
    
    // Если все попытки не удались, возвращаем нулевой баланс
    return {
      wallet,
      balance: 0,
      chains: []
    };
  }
  
  async processBatch(batch) {
    return Promise.all(batch.map(async (wallet, idx) => {
      const result = await this.fetchWalletBalance(wallet, idx);
      
      const row = {
        n: this.wallets.indexOf(wallet) + 1,
        Wallet: wallet,
        Balance: '$' + result.balance
      };
      
      this.total += result.balance;
      this.table.addRow(row);
      this.csvData.push(row);
      this.jsonData.push({
        n: this.wallets.indexOf(wallet) + 1,
        Wallet: wallet,
        Balance: result.balance,
        chains: result.chains ? result.chains.sort((a, b) => b.usd_value - a.usd_value) : []
      });
      
      this.progressBar.update(this.wallets.indexOf(wallet) + 1);
      
      return result;
    }));
  }
  
  async checkAllWallets() {
    console.log(`Начинаем проверку ${this.wallets.length} кошельков...`);
    
    // Создаем более информативный прогресс-бар
    this.progressBar = new cliProgress.SingleBar({
      format: 'Прогресс: [{bar}] {percentage}% | {value}/{total} | Успешно: {successCount} | Ошибки: {failCount}',
      barCompleteChar: '\u2588',
      barIncompleteChar: '\u2591',
      hideCursor: true
    });
    
    this.progressBar.start(this.wallets.length, 0, {
      successCount: 0,
      failCount: 0
    });
    
    const batchSize = 3; // Уменьшаем размер пакета для работы с прокси
    const batchCount = Math.ceil(this.wallets.length / batchSize);
    
    for (let i = 0; i < batchCount; i++) {
      const startIndex = i * batchSize;
      const endIndex = Math.min((i + 1) * batchSize, this.wallets.length);
      const batch = this.wallets.slice(startIndex, endIndex);
      
      await this.processBatch(batch);
      
      // Обновляем прогресс-бар с дополнительной информацией
      this.progressBar.update(this.successCount + this.failCount, {
        successCount: this.successCount,
        failCount: this.failCount
      });
      
      // Пауза между пакетами запросов
      if (i < batchCount - 1) {
        await sleep(3000);
      }
    }
    
    this.progressBar.stop();
    
    console.log(`\nПроверка завершена. Успешно: ${this.successCount}, Ошибки: ${this.failCount}`);
    console.log("\nРезультаты проверки:");
    
    // Добавляем пустую строку и итоговую информацию
    this.table.addRow({});
    this.table.addRow({
      Wallet: 'Итого',
      Balance: '$' + this.total.toLocaleString() // форматируем число для читаемости
    });
    
    // Добавляем статистику
    this.table.addRow({});
    this.table.addRow({
      Wallet: 'Статистика',
      Balance: `Успешно: ${this.successCount} | Ошибки: ${this.failCount}`
    });
    
    // Выводим таблицу
    this.table.printTable();
    
    // Сохраняем в CSV с итоговой строкой
    this.csvData.push({
      n: '',
      Wallet: '',
      Balance: ''
    });
    this.csvData.push({
      n: '',
      Wallet: 'ИТОГО:',
      Balance: '$' + this.total.toLocaleString()
    });
    
    await this.csvWriter.writeRecords(this.csvData);
    console.log('Результаты сохранены в wallet-balances.csv');
    
    return {
      wallets: this.jsonData,
      total: this.total,
      successCount: this.successCount,
      failCount: this.failCount
    };
  }
}

// Функция для запуска проверки
async function checkWalletBalances(walletsFilePath, proxiesFilePath = null) {
  try {
    const checker = new WalletBalanceChecker(walletsFilePath, proxiesFilePath);
    await checker.init();
    const result = await checker.checkAllWallets();
    
    // Добавляем небольшую задержку перед завершением
    console.log("Завершение работы скрипта...");
    setTimeout(() => {
      process.exit(0); // Явно завершаем процесс
    }, 1000);
    
    return result;
  } catch (error) {
    console.error("Произошла критическая ошибка:", error);
    process.exit(1);
  }
}

// Пример использования
const walletsFile = './wallets.txt'; // Путь к файлу с адресами кошельков
const proxiesFile = './proxies.txt'; // Путь к файлу с прокси
checkWalletBalances(walletsFile, proxiesFile).catch(error => {
  console.error("Ошибка при выполнении скрипта:", error);
  process.exit(1);
});

export { WalletBalanceChecker, checkWalletBalances }; 