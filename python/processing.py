import math

ROWS = 7
COLS = 5


def process_power_matrix(matrix):
    """
    Accept a 7x5 matrix in milliwatts.

    Returns:
        validated power matrix
        average power in mW
    """

    if not isinstance(matrix, list) or len(matrix) != ROWS:
        raise ValueError("Power matrix must have 7 rows")

    result = []

    for row in matrix:
        if not isinstance(row, list) or len(row) != COLS:
            raise ValueError("Each row must contain 5 values")

        values = [float(value) for value in row]

        if not all(math.isfinite(v) for v in values):
            raise ValueError("Invalid power measurement")

        result.append(values)

    average_power = (
        sum(sum(row) for row in result) / (ROWS * COLS)
    )

    return result, average_power