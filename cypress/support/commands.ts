// #region Types
type DomAndElementDescription = {
    dom: string;
    elementDescription: string;
}

type ElementDescriptionAndPageUrl = {
    elementDescription: string;
    pageUrl: string;
}

// Options pour la commande getByAI
type GetByAIOptions = {
    backupSelector?: string;
    log?: boolean;
    model?: string;
    retryCount?: number;
    timeout?: number;
    useHistory?: boolean;
}

type GetByAi = (elementDescription: string, options?: GetByAIOptions) => Cypress.Chainable<JQuery<HTMLElement>>

// Un item d'historique d'interaction avec la page
type HistoryItem = {
    timestamp: number
    pageUrl: string
    elementDescription: string
    pageDOM: string
    aiResponse: {
        selector: string
    }
    elementFound: boolean
    // Optionnel : pour une identification plus facile
    id?: string
}

type OllamaOptions = {
    model: string
}

type OllamaResponse = {
    selector: string
}

// Tableau d'items d'historique
type SelectorsHistory = HistoryItem[]
// #endregion

// #region Constants
// Default options pour getByAI
const getByAiDefaultOptions: GetByAIOptions = {
    model: "deepseek-coder-v2:latest",
    retryCount: 1,
    useHistory: true,
}

const ollamaDefaultOptions: OllamaOptions = {
    model: "deepseek-coder-v2:latest"
}
// #endregion

// #region Functions
const addOrUpdateHistoryItem = (newItem: HistoryItem): Cypress.Chainable<void> => {
    return readHistoryFile().then((history) => {
        const { item: existingItem, index } = findExistingHistoryItem(history, {
            pageUrl: newItem.pageUrl,
            elementDescription: newItem.elementDescription,
            selector: newItem.aiResponse.selector
        })

        if (existingItem && index !== -1) {
            // Mettre à jour l'item existant
            console.log("Updating existing history item")
            history[index] = {
                ...existingItem,
                timestamp: newItem.timestamp,
                elementFound: newItem.elementFound,
                pageDOM: newItem.pageDOM // On met à jour le DOM aussi au cas où
            }
        } else {
            // Ajouter le nouvel item
            console.log("Adding new history item")
            history.push(newItem)
        }

        return replaceHistoryFile(history)
    })
}

// Fonction utilitaire pour générer un sélecteur via Ollama
const askLLMForASelector = (params: DomAndElementDescription, options?: OllamaOptions): Cypress.Chainable<string> => {
    console.log("Asking LLM for selector with params:", params)
    return getPrompt(params).then((prompt) => {
        return savePromptFile(prompt).then(() => {
            return askOllama(prompt, options).then((answer) => {
                console.log("LLM answer:", answer)
                return saveAnswerFile(answer).then(() => {
                    return answer.selector
                })
            })
        })
    })
}

const askOllama = (
    prompt: string,
    options: OllamaOptions = ollamaDefaultOptions
): Cypress.Chainable<{
    selector: string
}> => {
    return cy.request("POST", "http://localhost:11434/api/generate", {
        format: "json",
        model: options.model,
        prompt,
        stream: false
    }).then((response) => {
        const answer = JSON.parse(response.body.response)
        return answer
    })
}

// Fonction utilitaire pour vérifier l'existence d'un sélecteur
const checkIfSelectorExists = (selector: string): Cypress.Chainable<boolean> => {
    console.log("Checking if selector exists:", selector)
    return cy.document().then((doc) => {
        const element = doc.querySelector(selector)
        const exists = element !== null
        console.log(`Selector ${exists ? 'exists' : 'does not exist'}:`, selector)
        return exists
    })
}

const cleanDomForAI = (dom: string): string => {
    // Supprimer les scripts, styles, commentaires
    return dom
        .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
        .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/\s+/g, ' ') // Normaliser les espaces
        .trim();
}

const findExistingHistoryItem = (
    history: SelectorsHistory,
    params: {
        pageUrl: string
        elementDescription: string
        selector: string
    }
): { item: HistoryItem | null; index: number } => {
    const targetKey = generateHistoryKey(params)

    for (let i = 0; i < history.length; i++) {
        const item = history[i]
        const itemKey = generateHistoryKey({
            pageUrl: item.pageUrl,
            elementDescription: item.elementDescription,
            selector: item.aiResponse.selector
        })

        if (itemKey === targetKey) {
            console.log("Found existing history item at index:", i)
            return { item, index: i }
        }
    }

    console.log("No existing history item found")
    return { item: null, index: -1 }
}

const generateHistoryKey = (params: {
    pageUrl: string
    elementDescription: string
    selector: string
}): string => {
    return `${params.pageUrl}|${params.elementDescription}|${params.selector}`
}

const getBodyOuterHTML = (): Cypress.Chainable<string> => {
    return cy.document().then((doc) => {
        return doc.body.outerHTML;
    });
}

export const getByAi: GetByAi = (elementDescription: string, options: GetByAIOptions = getByAiDefaultOptions) => {
    return cy.url().then((currentUrl) => {
        return getLastSuccessfulHistoryItem({
            elementDescription,
            pageUrl: currentUrl
        }).then((lastSuccessfulItem) => {
            if (lastSuccessfulItem) {
                return checkIfSelectorExists(lastSuccessfulItem.aiResponse.selector).then((exists) => {
                    if (exists) {
                        return cy.get(lastSuccessfulItem.aiResponse.selector)
                    } else {
                        // L'élément historique n'existe plus, on demande à l'IA
                        return processWithAI(elementDescription, currentUrl)
                    }
                })
            } else {
                // Pas d'historique, on demande à l'IA
                return processWithAI(elementDescription, currentUrl)
            }
        })
    })
}

const getLastSuccessfulHistoryItem = (params: ElementDescriptionAndPageUrl): Cypress.Chainable<HistoryItem | null> => {
    console.log("Getting last successful history item with params:", params)
    return readHistoryFile().then((history) => {
        const sortedHistory: SelectorsHistory = sortHistoryByTimestamp(history)

        // Chercher d'abord par description et URL exacte
        const exactMatches = sortedHistory.filter((item) => {
            return item.elementDescription === params.elementDescription &&
                item.pageUrl === params.pageUrl &&
                item.elementFound
        })

        if (exactMatches.length > 0) {
            console.log("Found exact match history item:", exactMatches[0])
            return exactMatches[0]
        }

        // Fallback: chercher juste par description (pour des URLs légèrement différentes)
        const descriptionMatches = sortedHistory.filter((item) => {
            return item.elementDescription === params.elementDescription &&
                item.elementFound
        })

        if (descriptionMatches.length > 0) {
            console.log("Found description match history item:", descriptionMatches[0])
            return descriptionMatches[0]
        }

        console.log("No history item found")
        return null
    })
}

const getPrompt = (options: {
    elementDescription: string
    dom: string
}): Cypress.Chainable<string> => {
    const { elementDescription, dom } = options
    return readBasePromptFile()
        .then((basePrompt) => {
            return basePrompt
                .replace("{{REPLACE_ME_DOM}}", dom)
                .replace("{{REPLACE_ME_ELEMENT_DESCRIPTION}}", elementDescription)
        })
}

const processWithAI = (elementDescription: string, pageUrl: string): Cypress.Chainable<JQuery<HTMLElement>> => {
    return getBodyOuterHTML().then((bodyHtml) => {
        const cleanedDom = cleanDomForAI(bodyHtml)
        return askLLMForASelector({
            dom: cleanedDom,
            elementDescription
        }).then((selector) => {
            return checkIfSelectorExists(selector).then((exists) => {
                return addOrUpdateHistoryItem({
                    timestamp: Date.now(),
                    pageUrl: pageUrl,
                    elementDescription,
                    pageDOM: cleanedDom,
                    aiResponse: {
                        selector
                    },
                    elementFound: exists
                }).then(() => {
                    if (exists) {
                        return cy.get(selector)
                    } else {
                        throw new Error(`Element not found for description: ${elementDescription} with selector: ${selector}`)
                    }
                })
            })
        })
    })
}

const readBasePromptFile = (): Cypress.Chainable<string> => {
    return cy.readFile('cypress/support/prompt.md');
}

const readHistoryFile = (): Cypress.Chainable<SelectorsHistory> => {
    return cy.readFile('history.json', { log: false }).then((data: any) => {
        try {
            if (!Array.isArray(data)) return []
            return data as SelectorsHistory
        } catch {
            return []
        }
    })
}

const replaceHistoryFile = (history: SelectorsHistory): Cypress.Chainable<void> => {
    return cy.writeFile('history.json', history)
}

// Fonction utilitaire pour sauvegarder les réponses du LLM pour debug
const saveAnswerFile = (answer: { selector: string }): Cypress.Chainable<void> => {
    const now = new Date()
    const dateStr = now.toDateString()
    const timeStr = now.toTimeString()
    const fileName = `${dateStr} ${timeStr}.md`
    return cy.writeFile(
        'cypress/answers/' + fileName,
        JSON.stringify(answer, null, 2)
    )
}

// Fonction utilitaire pour sauvegarder les prompts pour debug
const savePromptFile = (prompt: string): Cypress.Chainable<void> => {
    const now = new Date()
    const dateStr = now.toDateString()
    const timeStr = now.toTimeString()
    const fileName = `${dateStr} ${timeStr}.md`
    return cy.writeFile(
        'cypress/prompts/' + fileName,
        prompt
    )
}

const sortHistoryByTimestamp = (history: SelectorsHistory): SelectorsHistory => {
    return history.sort((a, b) => b.timestamp - a.timestamp)
}

export const visitLoginPage = () => {
    cy.visit('app/index.html');
}
// #endregion

// #region Cypress Commands
Cypress.Commands.add('getByAI', getByAi);
Cypress.Commands.add('visitLoginPage', visitLoginPage);
// #endregion

// #region TypeScript Definitions
declare global {
    namespace Cypress {
        interface Chainable {
            getByAI(elementDescription: string, options?: GetByAIOptions): Chainable<JQuery<HTMLElement>>;
            visitLoginPage(): Chainable<void>;
        }
    }
}
// #endregion