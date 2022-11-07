/**
 * 
 * @param {number} n 
 * @returns 
 */
function randomNBit(n) {
    return Math.floor(Math.random() * 2 ** n);
}

/**
 * 
 * @param {string} process 
 * @param {string} message 
 */
function logging(process,message) {
    console.info(`[${process}] ${message}`);
}

module.exports = {
    randomNBit,
    logging
}