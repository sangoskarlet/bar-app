// ВСТАВЬТЕ СЮДА ID ВАШЕЙ ТАБЛИЦЫ
const SPREADSHEET_ID = "1kXzNlk6ZvxK_HqUuI6zDjubD7V6L0oAFNl5s6rB91-o";

function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);
    const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
    const todayStr = new Date().toLocaleDateString('ru-RU');

    // ================= 1. ПОЛУЧЕНИЕ ГРАФИКА =================
    if (data.action === "get_schedule") {
      const sheet = ss.getSheetByName("График");
      // МЕНЯЕМ getValues() на getDisplayValues()
      const values = sheet.getDataRange().getDisplayValues(); 
      return ContentService.createTextOutput(JSON.stringify(values)).setMimeType(ContentService.MimeType.JSON);
    }
    // ================= 2. ПРОВЕРКА ВЫПОЛНЕНИЯ ЗА СЕГОДНЯ =================
    if (data.action === "check_completion") {
      const sheetsToCheck = ["1 этаж", "2 этаж", "Чеклист", "Ежедневная уборка"];
      let results = {};

      sheetsToCheck.forEach(name => {
        const s = ss.getSheetByName(name);
        if (!s) { results[name] = false; return; }
        
        const values = s.getDataRange().getValues();
        // Проверяем колонку B (индекс 1) на наличие сегодняшней даты
        const found = values.some(row => {
          const cell = row[1];
          if (cell instanceof Date) {
            return cell.toLocaleDateString('ru-RU') === todayStr;
          }
          return cell.toString().includes(todayStr);
        });
        results[name] = found;
      });
      return ContentService.createTextOutput(JSON.stringify(results)).setMimeType(ContentService.MimeType.JSON);
    }

    // ================= 3. ЗАПИСЬ ДАННЫХ В ЛИСТЫ =================
    const sheetName = data.sheet;
    const sheet = ss.getSheetByName(sheetName);
    if (!sheet) return ContentService.createTextOutput("Ошибка: Лист " + sheetName + " не найден");

    // --- ПЕРЕНОСЫ И СПИСАНИЯ ---
    if (sheetName === "Переносы" || sheetName === "Списания") {
      // Столбцы: Дата | Имя | Предмет | Кол-во | Направление
      sheet.appendRow([new Date(), data.user, data.item, data.qty, data.direction || ""]);
      return ContentService.createTextOutput("OK: Запись добавлена");
    }

    // --- ЕЖЕДНЕВНАЯ УБОРКА (ПО ДНЯМ НЕДЕЛИ) ---
    if (sheetName === "Ежедневная уборка") {
      const dayFromBot = data.day.toLowerCase().trim(); // например "понедельник"
      const firstRow = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
      let dayColIdx = -1;

      // Ищем в 1-й строке столбец с текущим днем недели
      for (let i = 0; i < firstRow.length; i++) {
        if (firstRow[i].toString().toLowerCase().trim() === dayFromBot) {
          dayColIdx = i + 1;
          break;
        }
      }

      if (dayColIdx !== -1) {
        let newRow = new Array(firstRow.length).fill("");
        newRow[0] = data.user;      // А: Сотрудник
        newRow[1] = new Date();     // B: Дата
        newRow[dayColIdx - 1] = "✅"; // В нужный столбец дня недели
        sheet.appendRow(newRow);
        return ContentService.createTextOutput("OK: Уборка записана в столбец " + dayFromBot);
      } else {
        return ContentService.createTextOutput("Ошибка: Столбец '" + dayFromBot + "' не найден в 1-й строке");
      }
    }

    // --- ЧЕКЛИСТЫ И ТЕМПЕРАТУРЫ (ГОРИЗОНТАЛЬНАЯ ЗАПИСЬ) ---
    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    const targetItem = (data.fridge || data.task || "").toString().toLowerCase().trim();
    const valueToSet = data.temp || data.val || "";
    const sessionId = data.session_id;

    // Ищем индекс колонки по названию задачи/холодильника
    let colIndex = -1;
    for (let i = 0; i < headers.length; i++) {
      if (headers[i].toString().toLowerCase().trim() === targetItem) {
        colIndex = i + 1;
        break;
      }
    }

    if (colIndex === -1) return ContentService.createTextOutput("Ошибка: Колонка '" + targetItem + "' не найдена");

    // Ищем строку с таким же ID сессии в колонке C (индекс 3)
    const lastRow = sheet.getLastRow();
    let rowToUpdate = -1;
    if (lastRow > 1) {
      const sessionIds = sheet.getRange(2, 3, lastRow - 1, 1).getValues();
      for (let i = 0; i < sessionIds.length; i++) {
        if (sessionIds[i][0].toString() === sessionId) {
          rowToUpdate = i + 2;
          break;
        }
      }
    }

    if (rowToUpdate === -1) {
      // Создаем новую строку для новой сессии
      let newRowData = new Array(headers.length).fill("");
      newRowData[0] = data.user;      // A: Имя
      newRowData[1] = new Date();     // B: Дата
      newRowData[2] = sessionId;      // C: ID сессии
      newRowData[colIndex - 1] = valueToSet; 
      sheet.appendRow(newRowData);
    } else {
      // Обновляем существующую строку сессии
      sheet.getRange(rowToUpdate, colIndex).setValue(valueToSet);
    }

    return ContentService.createTextOutput("OK: Данные внесены");

  } catch (err) {
    return ContentService.createTextOutput("ERROR: " + err.toString());
  }
}