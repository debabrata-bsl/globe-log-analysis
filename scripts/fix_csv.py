import csv

input_file = r'C:\Users\debab\OneDrive\Desktop\Log error Check\my_error_report.csv'
output_file = r'C:\Users\debab\OneDrive\Desktop\Log error Check\viewer-app\public\my_error_report.csv'

with open(input_file, 'r', encoding='utf-8') as f_in:
    with open(output_file, 'w', encoding='utf-8', newline='') as f_out:
        reader = csv.reader(f_in)
        writer = csv.writer(f_out)
        
        for row in reader:
            writer.writerow(row[:5])

print('Done')